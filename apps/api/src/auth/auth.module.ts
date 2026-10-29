import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService, createSessionStore, REDIS, type SessionStore } from './auth.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    { provide: REDIS, useFactory: (): SessionStore => createSessionStore() },
  ],
  exports: [AuthService, AuthGuard, REDIS],
})
export class AuthModule {}
