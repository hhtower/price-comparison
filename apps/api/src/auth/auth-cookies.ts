import { SESSION_TTL_SECONDS } from './auth.service.js';

export function readSessionToken(cookie: string | undefined): string | undefined {
  return cookie?.match(/(?:^|;\s*)admin_session=([^;]+)/)?.[1];
}

export function sessionCookie(token: string): string {
  return `admin_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function expiredSessionCookie(): string {
  return 'admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
}
