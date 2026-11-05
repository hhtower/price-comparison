import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { McpCaptcha } from '../mcp/mcp-captcha.js';
import { McpMailer } from '../mcp/mcp-mailer.js';
import { AccountController } from './account.controller.js';
import { AccountGuard } from './account.guard.js';
import { AccountService } from './account.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AccountController],
  providers: [AccountService, AccountGuard, McpCaptcha, { provide: McpMailer, useFactory: () => new McpMailer() }],
  exports: [AccountService, AccountGuard],
})
export class AccountModule {}
