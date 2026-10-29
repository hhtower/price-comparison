import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards, ValidationPipe } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { expiredSessionCookie, readSessionToken, sessionCookie } from './auth-cookies.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';

interface AuthenticatedRequest extends FastifyRequest {
  user?: { userId: string };
}

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body(new ValidationPipe({ expectedType: LoginDto, transform: true, whitelist: true, forbidNonWhitelisted: true })) body: LoginDto, @Res({ passthrough: true }) response: FastifyReply): Promise<{ ok: true }> {
    const session = await this.auth.login(body.password);
    response.header('set-cookie', [sessionCookie(session.token)]);
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: FastifyReply): Promise<{ ok: true }> {
    const token = readSessionToken(request.headers.cookie);
    await this.auth.logout(token);
    response.header('set-cookie', [expiredSessionCookie()]);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() request: AuthenticatedRequest): { userId: string } {
    return { userId: request.user!.userId };
  }
}
