import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Resvg } from '@resvg/resvg-js';
import { REDIS } from '../auth/auth.service.js';
import { DomainValidationError } from '../common/errors.js';
import { RATE_LIMIT_STORE, RateLimitExceededException, type RateLimitStore } from '../common/rate-limit.guard.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (id: string, answer: string, address: string) => hash(`${id}\0${answer}\0${address}`);
const invalid = () => new DomainValidationError('MCP_CAPTCHA_INVALID', '图形验证码错误、已使用或已过期，请换一张后重试');
const paths = [
  'M10 2C-1 2-1 30 10 30C21 30 21 2 10 2Z',
  'M3 8L10 2V30M3 30H17',
  'M1 8C1-1 19-1 19 8C19 15 1 23 1 30H19',
  'M1 3C19-2 24 16 8 16M8 16C24 16 22 35 1 28',
  'M15 30V2L0 21H20',
  'M19 2H2L1 16C25 6 27 37 1 28',
  'M18 3C-3-6-6 39 16 29C27 17 2 9 0 23',
  'M0 2H20L6 30',
  'M10 16C-6 14 0-5 15 3C26 10 16 15 10 16C-8 17-1 38 16 29C26 21 17 16 10 16Z',
  'M19 9C16-7-6 4 2 15C9 24 25 13 19 9M19 9C25 31 6 35 2 27',
];

function image(answer: string): string {
  // shortcut: a local visual challenge deters simple scripts; use managed bot protection if OCR abuse appears.
  const noise = Array.from({ length: 5 }, () => `<path d="M${randomInt(180)} ${randomInt(52)}Q${randomInt(180)} ${randomInt(52)} ${randomInt(180)} ${randomInt(52)}" stroke="#98b6ae" stroke-width="1" fill="none"/>`).join('');
  const digits = [...answer].map((digit, index) => `<path d="${paths[Number(digit)]}" transform="translate(${12 + index * 34 + randomInt(-2, 3)} ${10 + randomInt(-2, 3)}) rotate(${randomInt(-12, 13)} 10 16)" stroke="${index % 2 ? '#253b4c' : '#16665b'}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="186" height="54" viewBox="0 0 186 54"><rect width="186" height="54" rx="7" fill="#f0f6f2"/>${noise}${digits}</svg>`;
  const png = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
  return `data:image/png;base64,${png.toString('base64')}`;
}

@Injectable()
export class McpCaptcha {
  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, 'set' | 'getdel'>,
    @Inject(RATE_LIMIT_STORE) private readonly limits: RateLimitStore,
  ) {}

  async create(address: string) {
    let limit;
    try { limit = await this.limits.hit(`mcp:captcha:issue:${hash(address)}`, 3_600_000); }
    catch { throw new ServiceUnavailableException('验证码服务暂不可用，请稍后重试'); }
    if (!Number.isSafeInteger(limit.count) || limit.count < 1) throw new ServiceUnavailableException('验证码服务暂不可用');
    if (limit.count > 20) throw new RateLimitExceededException();
    const id = randomBytes(32).toString('base64url');
    const answer = Array.from({ length: 5 }, () => randomInt(10)).join('');
    try {
      if (await this.redis.set(`mcp:captcha:${id}`, digest(id, answer, address), 'EX', 300) !== 'OK') throw new Error('Captcha not saved');
    } catch { throw new ServiceUnavailableException('验证码服务暂不可用，请稍后重试'); }
    return { id, image: image(answer), expiresInSeconds: 300 };
  }

  async verify(inputId: unknown, inputAnswer: unknown, address: string): Promise<void> {
    if (typeof inputId !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(inputId)) throw invalid();
    let expected;
    try { expected = await this.redis.getdel(`mcp:captcha:${inputId}`); }
    catch { throw new ServiceUnavailableException('验证码服务暂不可用，请稍后重试'); }
    const answer = typeof inputAnswer === 'string' ? inputAnswer.trim() : '';
    if (!expected || !/^[a-f0-9]{64}$/u.test(expected) || !/^[0-9]{5}$/u.test(answer)
      || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(digest(inputId, answer, address), 'hex'))) throw invalid();
  }
}
