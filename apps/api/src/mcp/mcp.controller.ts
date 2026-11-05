import { Body, Controller, Get, Header, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard.js';
import { AccountGuard } from '../account/account.guard.js';
import { DomainValidationError } from '../common/errors.js';
import { McpAccess } from './mcp-access.js';
import { McpCaptcha } from './mcp-captcha.js';

type Request = {
  ip?: string; headers: Record<string, string | string[] | undefined>;
  user?: { userId: string }; accountUser?: { id: string; email: string };
};

function field(input: unknown, name: string): string {
  const result = z.object({ [name]: z.string() }).strict().safeParse(input);
  if (!result.success) throw new DomainValidationError('INVALID_MCP_INPUT', '请求参数无效');
  return result.data[name]!;
}

function clientAddress(request: Request): string {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = request.headers['x-forwarded-for'];
    const address = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (address?.trim()) return address.split(',', 1)[0]!.trim();
  }
  return request.ip ?? 'unknown';
}

@Controller({ path: 'mcp', version: '1' })
export class McpController {
  constructor(
    @Inject(McpAccess) private readonly access: McpAccess,
    @Inject(McpCaptcha) private readonly captcha: McpCaptcha,
  ) {}

  @Get('config')
  @Header('Cache-Control', 'no-store')
  config() { return this.access.config(); }

  @Get('captcha')
  @Header('Cache-Control', 'no-store')
  challenge(@Req() request: Request) {
    return this.captcha.create(clientAddress(request));
  }

  @Get('application')
  @UseGuards(AccountGuard)
  @Header('Cache-Control', 'no-store')
  application(@Req() request: Request) { return this.access.getForAccount(request.accountUser!.email); }

  @Post('applications')
  @UseGuards(AccountGuard)
  @Header('Cache-Control', 'no-store')
  apply(@Body() body: unknown, @Req() request: Request) {
    return this.access.applyForAccount(body, request.accountUser!.email);
  }

  @Post('application/claim')
  @UseGuards(AccountGuard)
  @Header('Cache-Control', 'no-store')
  claimForAccount(@Req() request: Request) { return this.access.claimForAccount(request.accountUser!.email); }

  @Post('applications/verify')
  @Header('Cache-Control', 'no-store')
  verify(@Body() body: unknown) { return this.access.verify(field(body, 'token')); }

  @Post('applications/claim')
  @Header('Cache-Control', 'no-store')
  claim(@Body() body: unknown) { return this.access.claim(field(body, 'token')); }
}

@Controller({ path: 'admin/mcp/applications', version: '1' })
@UseGuards(AuthGuard)
export class AdminMcpController {
  constructor(@Inject(McpAccess) private readonly access: McpAccess) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query() query: Record<string, unknown>) { return this.access.list(query); }

  @Post(':id/approve')
  approve(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    return this.access.approve(id, body, request.user!.userId);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    return this.access.reject(id, field(body, 'reviewNote'), request.user!.userId);
  }

  @Post(':id/reissue')
  reissue(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    return this.access.reissue(id, body, request.user!.userId);
  }

  @Post(':id/resend')
  resend(@Param('id') id: string) { return this.access.resend(id); }

  @Post(':id/revoke')
  revoke(@Param('id') id: string, @Req() request: Request) { return this.access.revoke(id, request.user!.userId); }
}
