import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import '../src/config/env.js';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { Global, Module, Scope, type INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthService } from '../src/auth/auth.service.js';
import { DatabaseModule } from '../src/database/database.module.js';
import { DATABASE, DatabaseService, PG_POOL } from '../src/database/database.providers.js';

describe('GET /health', () => {
  let app: INestApplication;
  let testingModule: TestingModule;
  let databaseResolutions: number;

  beforeEach(async () => {
    databaseResolutions = 0;
    const databaseTokens = [PG_POOL, DATABASE, DatabaseService];
    class ProbeDatabaseModule {}
    class ProbeAuthModule {}
    Module({
      providers: [
        AuthGuard,
        { provide: AuthService, useValue: { validate: async () => null } },
      ],
      exports: [AuthGuard, AuthService],
    })(ProbeAuthModule);
    Global()(ProbeDatabaseModule);
    Module({
      providers: databaseTokens.map((provide) => ({
        provide,
        scope: Scope.REQUEST,
        useFactory: () => {
          databaseResolutions += 1;
          throw new Error('Health must not resolve a database provider');
        },
      })),
      exports: databaseTokens,
    })(ProbeDatabaseModule);

    testingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(DatabaseModule)
      .useModule(ProbeDatabaseModule)
      .overrideModule(AuthModule)
      .useModule(ProbeAuthModule)
      .compile();
    app = testingModule.createNestApplication(new FastifyAdapter({ logger: false }));
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    await testingModule?.close();
  });

  it('returns ok without requiring a database connection', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.payload), { ok: true });
    assert.equal(databaseResolutions, 0, 'health must not instantiate database providers');
  });

  it('detects database provider resolution with the request-scoped probe', async () => {
    await assert.rejects(
      testingModule.resolve(DATABASE),
      /Health must not resolve a database provider/,
    );
    assert.equal(databaseResolutions, 1);
  });
});
