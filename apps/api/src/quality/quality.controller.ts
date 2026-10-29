import { Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { QUALITY_CATALOG } from './quality.catalog.js';
import { QualityService } from './quality.service.js';
import type { QualityReport } from './quality.types.js';

function token(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length > 263) throw new NotFoundException('检测任务不存在或已过期');
  return authorization.slice(7);
}
@Controller({ path: 'quality', version: '1' })
export class QualityController {
  constructor(@Inject(QualityService) private readonly service: QualityService) {}
  @Get('catalog') catalogue() { return QUALITY_CATALOG; }
  @Post('models') @HttpCode(200)
  async models(@Body() input: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    const controller = new AbortController();
    const close = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', close);
    if (reply.raw.destroyed) controller.abort();
    try { return await this.service.models(input, controller.signal); }
    finally { reply.raw.off('close', close); }
  }
  @Post('tasks') create(@Body() input: unknown) { return this.service.create(input); }
  @Get('tasks/:id') read(@Param('id') id: string, @Headers('authorization') authorization: string | undefined) { return this.service.read(id, token(authorization)); }
  @Post('tasks/:id/cancel') @HttpCode(200)
  cancel(@Param('id') id: string, @Headers('authorization') authorization: string | undefined) { return this.service.cancel(id, token(authorization)); }
  @Post('tasks/:id/retest')
  retest(@Param('id') id: string, @Headers('authorization') authorization: string | undefined, @Body() input: unknown) { return this.service.retest(id, token(authorization), input); }
  @Get('tasks/:id/events')
  async events(@Param('id') id: string, @Headers('authorization') authorization: string | undefined, @Res() reply: FastifyReply): Promise<void> {
    const accessToken = token(authorization);
    await this.service.read(id, accessToken);
    let unsubscribe: () => void = () => {}; let timer: ReturnType<typeof setInterval> | undefined; let ended = false;
    const close = () => { if (ended) return; ended = true; if (timer) clearInterval(timer); unsubscribe(); if (!reply.raw.destroyed) reply.raw.end(); };
    // Subscribe first so connection-limit errors still use the normal HTTP error path.
    const pending: QualityReport[] = []; let ready = false;
    const send = (report: QualityReport) => {
      if (!ready) { pending.push(report); return; }
      if (ended) return;
      if (reply.raw.writableLength > 65_536 || reply.raw.destroyed) { close(); return; }
      reply.raw.write('data: ' + JSON.stringify(report) + '\n\n');
      if (['completed', 'cancelled', 'failed'].includes(report.state)) close();
    };
    unsubscribe = await this.service.subscribe(id, accessToken, send);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    reply.raw.on('close', close); ready = true;
    for (const report of pending) send(report);
    if (!ended) { timer = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); else close(); }, 15_000); timer.unref?.(); }
  }
}
