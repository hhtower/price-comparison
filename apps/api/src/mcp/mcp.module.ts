import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AccountModule } from '../account/account.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { McpAccess } from './mcp-access.js';
import { McpMailer } from './mcp-mailer.js';
import { AdminMcpController, McpController } from './mcp.controller.js';
import { McpCaptcha } from './mcp-captcha.js';

@Module({
  imports: [AuthModule, AccountModule, CatalogModule],
  controllers: [McpController, AdminMcpController],
  providers: [McpAccess, McpCaptcha, { provide: McpMailer, useFactory: () => new McpMailer() }],
  exports: [McpAccess],
})
export class McpModule {}
