export type CrawlerResponseClass = 'ok' | 'blocked' | 'server_error';

export function classifyResponse(status: number, headers: Readonly<Record<string, string | null | undefined>>): CrawlerResponseClass {
  if (status === 403 || status === 429) return 'blocked';
  if (status >= 500) {
    const mitigated = headers['cf-mitigated'];
    return typeof mitigated === 'string' && mitigated.toLowerCase() === 'challenge' ? 'blocked' : 'server_error';
  }
  return 'ok';
}
