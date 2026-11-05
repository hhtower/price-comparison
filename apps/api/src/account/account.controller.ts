import { Body, Controller, Get, Header, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AccountService } from './account.service.js';
import { accountCookie, expiredAccountCookie, readAccountToken } from './account-cookies.js';

function address(request: FastifyRequest): string {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first?.trim()) return first.split(',', 1)[0]!.trim();
  }
  return request.ip ?? 'unknown';
}

@Controller({ path: 'account', version: '1' })
export class AccountController {
  constructor(@Inject(AccountService) private readonly service: AccountService) {}

  @Get('session')
  @Header('Cache-Control', 'no-store')
  async session(@Req() request: FastifyRequest) {
    return { user: await this.service.validate(readAccountToken(request.headers.cookie)) };
  }

  @Post('email-code')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  sendCode(@Body() input: unknown, @Req() request: FastifyRequest) {
    return this.service.sendCode(input, address(request));
  }

  @Post('verify-email')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async verify(@Body() input: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.service.verifyEmail(input);
    if ('sessionToken' in result) {
      reply.header('set-cookie', accountCookie(result.sessionToken));
      return { user: result.user };
    }
    return result;
  }

  @Post('register')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async register(@Body() input: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.service.register(input);
    reply.header('set-cookie', accountCookie(result.sessionToken));
    return { user: result.user };
  }

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(@Body() input: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.service.login(input, address(request));
    reply.header('set-cookie', accountCookie(result.sessionToken));
    return { user: result.user };
  }

  @Post('logout')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.service.logout(readAccountToken(request.headers.cookie));
    reply.header('set-cookie', expiredAccountCookie());
    return { ok: true };
  }
}
