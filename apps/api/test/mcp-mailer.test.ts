import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpMailer, readMcpMailConfig } from '../src/mcp/mcp-mailer.js';

const env = {
  SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_FROM: 'Quotes <quotes@example.com>',
  SMTP_USER: 'quotes', SMTP_PASSWORD: 'test-secret', PUBLIC_SITE_URL: 'https://quotes.example.com',
};

test('SMTP requires an HTTPS site, valid sender and TLS; missing configuration disables only MCP applications', () => {
  assert.equal(readMcpMailConfig({}), null);
  assert.equal(new McpMailer({}).enabled(), false);
  const config = readMcpMailConfig(env)!;
  assert.equal(config.transport.requireTLS, true);
  assert.equal(config.transport.secure, false);
  assert.equal(config.origin, env.PUBLIC_SITE_URL);
  assert.equal(readMcpMailConfig({ ...env, SMTP_SECURE: 'true', SMTP_PORT: '465' })!.transport.secure, true);
  for (const override of [
    { PUBLIC_SITE_URL: 'http://example.com' }, { PUBLIC_SITE_URL: 'https://example.com/path' },
    { SMTP_PORT: 'NaN' }, { SMTP_FROM: 'a@example.com\r\nBcc: attacker@example.com' },
    { SMTP_SECURE: 'sometimes' }, { SMTP_PASSWORD: '' },
  ]) {
    assert.throws(() => readMcpMailConfig({ ...env, ...override }));
  }
});

test('mailer sends plain website links without logging credentials and rejects disabled configuration', async () => {
  const sent: unknown[] = [];
  const mailer = new McpMailer(env, () => ({ sendMail: async (message: unknown) => { sent.push(message); } }));
  await mailer.send('applicant@example.com', '验证申请邮箱', 'https://quotes.example.com/mcp#verify=test');
  assert.deepEqual(sent, [{
    from: env.SMTP_FROM, to: 'applicant@example.com', subject: '验证申请邮箱', text: 'https://quotes.example.com/mcp#verify=test',
    disableFileAccess: true, disableUrlAccess: true,
  }]);
  await assert.rejects(new McpMailer({}).send('x@example.com', 'test', 'test'));
});
