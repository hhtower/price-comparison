import {
  Body, Controller, Delete, Get, Headers, HttpCode, HttpException, Inject,
  Param, Post, Req, Res, ServiceUnavailableException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ASSISTANT_LIMITS, isTurnTerminal, validateAssistantInput, type TurnSnapshot,
} from '@price-comparison/catalog/assistant-contract';
import { DomainNotFoundError, DomainValidationError } from '../common/errors.js';
import { sleep } from '../common/sleep.js';
import { AssistantAccess, type AssistantSubscription } from './assistant-access.js';
import { readAssistantConfig } from './assistant.config.js';
import { AssistantRepository } from './assistant.repository.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function token(authorization: string | undefined): string {
  const match = typeof authorization === 'string' ? /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization) : null;
  if (!match) throw new DomainNotFoundError('ASSISTANT_NOT_FOUND', 'Assistant session unavailable');
  return match[1]!;
}
function objectBody(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function invalid(): never {
  throw new DomainValidationError('ASSISTANT_INVALID_INPUT', 'Invalid assistant input');
}
function generationEnabled(): void {
  try { if (readAssistantConfig().enabled) return; } catch { /* Fail closed without exposing model configuration. */ }
  throw new ServiceUnavailableException('Assistant unavailable');
}
async function publicResult<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof HttpException) throw error;
    throw new ServiceUnavailableException('Assistant unavailable');
  }
}
type ClientRequest = Pick<FastifyRequest, 'ip'> | { ip?: string; headers?: Record<string, string | string[] | undefined> };

@Controller({ path: 'assistant', version: '1' })
export class AssistantController {
  constructor(
    @Inject(AssistantRepository) private readonly repository: AssistantRepository,
    @Inject(AssistantAccess) private readonly access: AssistantAccess,
  ) {}

  @Get('status')
  status(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    try { return { enabled: readAssistantConfig().enabled }; }
    catch { throw new ServiceUnavailableException('Assistant unavailable'); }
  }

  @Post('sessions')
  async create(@Body() body: unknown, @Req() request: ClientRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    generationEnabled();
    objectBody(body === undefined ? {} : body, []);
    await this.access.admit('session', request, reply);
    return publicResult(() => this.repository.createSession());
  }

  @Get('sessions/:id')
  async read(@Param('id') id: string, @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    const accessToken = token(authorization);
    return publicResult(() => this.repository.readSession(id, accessToken));
  }

  @Post('sessions/:id/turns')
  @HttpCode(202)
  async send(@Param('id') id: string, @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown, @Req() request: ClientRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    const accessToken = token(authorization);
    await publicResult(() => this.repository.readSession(id, accessToken));
    generationEnabled();
    const source = objectBody(body, ['clientMessageId', 'expectedRevision', 'text']);
    if (typeof source.clientMessageId !== 'string' || !uuid.test(source.clientMessageId)
      || typeof source.expectedRevision !== 'number' || !Number.isSafeInteger(source.expectedRevision)
      || source.expectedRevision < 0) invalid();
    let text: string;
    try { text = validateAssistantInput(source.text); } catch { invalid(); }
    await this.access.admit('turn', request, reply);
    const result = await publicResult(() => this.repository.acceptTurn(id, accessToken, {
      clientMessageId: source.clientMessageId as string, expectedRevision: source.expectedRevision as number, text,
    }));
    reply.code(result.created ? 202 : 200);
    return result;
  }

  @Post('sessions/:id/turns/:turnId/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @Param('turnId') turnId: string,
    @Headers('authorization') authorization: string | undefined, @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    const accessToken = token(authorization);
    objectBody(body === undefined ? {} : body, []);
    return publicResult(() => this.repository.cancelTurn(id, turnId, accessToken));
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    reply.header('Cache-Control', 'no-store');
    const accessToken = token(authorization);
    await publicResult(() => this.repository.deleteSession(id, accessToken));
  }

  @Get('sessions/:id/turns/:turnId/events')
  async events(@Param('id') id: string, @Param('turnId') turnId: string,
    @Headers('authorization') authorization: string | undefined, @Res() reply: FastifyReply): Promise<void> {
    reply.header('Cache-Control', 'no-store');
    const controller = new AbortController();
    const close = () => controller.abort();
    const raw = reply.raw;
    raw.on('close', close);
    if (raw.destroyed || raw.writableEnded) close();
    let subscription: AssistantSubscription | undefined;
    let ready = false;
    const writable = () => !controller.signal.aborted && !raw.destroyed && !raw.writableEnded
      && raw.writableLength <= ASSISTANT_LIMITS.sseBufferMaxBytes;
    const write = (frame: string) => {
      if (!writable()) { close(); return; }
      raw.write(frame);
      if (!writable()) close();
    };
    try {
      const accessToken = token(authorization);
      let snapshot: TurnSnapshot = await publicResult(() => this.repository.readTurn(id, turnId, accessToken));
      generationEnabled();
      if (controller.signal.aborted) return;
      subscription = await this.access.acquire(id);
      if (controller.signal.aborted) return;
      reply.hijack();
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no', Connection: 'keep-alive',
      });
      ready = true;
      let version = -1;
      let heartbeatAt = Date.now();
      for (;;) {
        if (!writable()) break;
        if (snapshot.eventVersion > version) {
          write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
          version = snapshot.eventVersion;
        }
        if (isTurnTerminal(snapshot.status) || controller.signal.aborted) break;
        await sleep(ASSISTANT_LIMITS.ssePollMs, controller.signal);
        if (!writable()) break;
        if (Date.now() - heartbeatAt >= ASSISTANT_LIMITS.sseHeartbeatMs) {
          await subscription.renew();
          write(': heartbeat\n\n');
          heartbeatAt = Date.now();
        }
        if (!writable()) break;
        snapshot = await this.repository.readTurn(id, turnId, accessToken);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (!ready) throw error;
        write('event: error\ndata: {"error":{"code":"ASSISTANT_STREAM_UNAVAILABLE","message":"Assistant stream unavailable"}}\n\n');
      }
    } finally {
      close();
      raw.off('close', close);
      if (ready && !raw.destroyed && !raw.writableEnded) {
        if (raw.writableLength > ASSISTANT_LIMITS.sseBufferMaxBytes) raw.destroy();
        else raw.end();
      }
      // Expiry is the fallback if Redis goes away during disconnect cleanup.
      await subscription?.release().catch(() => undefined);
    }
  }
}
