import { ACCOUNT_SESSION_SECONDS } from './account.service.js';

export const readAccountToken = (cookie?: string): string | undefined => cookie?.match(/(?:^|;\s*)account_session=([^;]+)/u)?.[1];
export const accountCookie = (token: string): string => `account_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${ACCOUNT_SESSION_SECONDS}`;
export const expiredAccountCookie = (): string => 'account_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
