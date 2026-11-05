import { ServiceUnavailableException } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { isEmail } from 'class-validator';

export function readMcpMailConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const origin = new URL(env.PUBLIC_SITE_URL ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('PUBLIC_SITE_URL must be an HTTPS origin');
  }
  const from = env.SMTP_FROM?.trim() ?? '';
  const address = /<([^<>]+)>$/u.exec(from)?.[1] ?? from;
  if (/[\r\n]/u.test(from) || !isEmail(address)) throw new Error('SMTP_FROM must be a valid mailbox');
  const secure = env.SMTP_SECURE?.trim() || 'false';
  if (!['true', 'false'].includes(secure)) throw new Error('SMTP_SECURE must be true or false');
  const port = Number(env.SMTP_PORT?.trim() || (secure === 'true' ? '465' : '587'));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT is invalid');
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASSWORD;
  if (!!user !== !!pass) throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together');
  return {
    origin: origin.origin, from,
    transport: {
      host, port, secure: secure === 'true', requireTLS: true,
      ...(user ? { auth: { user, pass: pass! } } : {}),
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      logger: false as const, debug: false,
    },
  };
}

type MailConfig = NonNullable<ReturnType<typeof readMcpMailConfig>>;
type MailTransport = { sendMail(message: { from: string; to: string; subject: string; text: string; disableFileAccess: boolean; disableUrlAccess: boolean }): Promise<unknown> };

export class McpMailer {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly transport: (config: MailConfig['transport']) => MailTransport = config => createTransport(config),
  ) {}

  enabled(): boolean {
    try { return readMcpMailConfig(this.environment) !== null; }
    catch { return false; }
  }

  origin(): string { return this.config().origin; }

  async send(to: string, subject: string, text: string): Promise<void> {
    const config = this.config();
    try {
      await this.transport(config.transport).sendMail({
        from: config.from, to, subject, text, disableFileAccess: true, disableUrlAccess: true,
      });
    } catch {
      throw new ServiceUnavailableException('邮件发送失败，请稍后重试');
    }
  }

  private config(): MailConfig {
    try {
      const config = readMcpMailConfig(this.environment);
      if (config) return config;
    } catch { /* Configuration errors must not expose SMTP credentials to applicants. */ }
    throw new ServiceUnavailableException('MCP 申请暂未开放，请联系管理员配置邮件服务');
  }
}
