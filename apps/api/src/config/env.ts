import fs from 'node:fs';
import path from 'node:path';

function findProjectEnvFile(startDirectory: string = process.cwd()): string | undefined {
  let directory = path.resolve(startDirectory);
  for (;;) {
    const candidate = path.join(directory, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export const loadedEnvFile = findProjectEnvFile();

function positiveEnv(name: string, fallback: number, environment: NodeJS.ProcessEnv): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function readAiBatchLimits(environment: NodeJS.ProcessEnv = process.env) {
  return {
    maxItems: positiveEnv('AI_BATCH_MAX_ITEMS', 32, environment),
    maxInputBytes: positiveEnv('AI_BATCH_MAX_INPUT_BYTES', 24_576, environment),
    maxInputTokens: positiveEnv('AI_BATCH_MAX_INPUT_TOKENS', 6_000, environment),
  };
}

export const DEFAULT_CRAWLER_TARGET_INTERVAL_MS = 3_600_000;

const DEFAULT_CRAWLER_HOST_MIN_INTERVAL_MS: Readonly<Record<string, number>> = {
  'wzyp.cn': 500,
  'www.16688.com.cn': 1_000,
  'catfk.com': 10_000,
  'ldxp.cn': 1_000,
  'www.ldxp.cn': 1_000,
  'pay.ldxp.cn': 1_000,
  'pay.qxvx.cn': 1_000,
};

export interface CrawlerConfig {
  readonly proxies: readonly string[];
  /** 自建独立站专用出口；缺省回退 proxies[0]。 */
  readonly selfHostedProxyUrl?: string;
  readonly targetIntervalMs: number;
  readonly minIntervalMs?: number;
  readonly hostMinIntervalMs: ReadonlyMap<string, number>;
  readonly concurrency: number;
  readonly hostConcurrency: number;
}

function assertProxyUrl(name: string, value: string): void {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${name} contains invalid URL: ${value}`); }
  if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol)) {
    throw new Error(`${name} unsupported protocol: ${value}`);
  }
}

export function readCrawlerConfig(environment: NodeJS.ProcessEnv = process.env): CrawlerConfig {
  const targetIntervalMs = positiveEnv('CRAWLER_TARGET_INTERVAL_MS', DEFAULT_CRAWLER_TARGET_INTERVAL_MS, environment);
  const minIntervalMs = environment.CRAWLER_MIN_INTERVAL_MS?.trim()
    ? positiveEnv('CRAWLER_MIN_INTERVAL_MS', 1_000, environment) : undefined;
  if (minIntervalMs !== undefined && (minIntervalMs < 1_000 || minIntervalMs > targetIntervalMs)) {
    throw new Error('CRAWLER_MIN_INTERVAL_MS must be >= 1000 and <= CRAWLER_TARGET_INTERVAL_MS');
  }
  const proxies = (environment.CRAWLER_PROXIES ?? '').split(',').map(item => item.trim()).filter(Boolean);
  for (const proxy of proxies) assertProxyUrl('CRAWLER_PROXIES', proxy);
  const selfHostedProxyUrl = environment.CRAWLER_SELFHOSTED_PROXY_URL?.trim() || undefined;
  if (selfHostedProxyUrl !== undefined) assertProxyUrl('CRAWLER_SELFHOSTED_PROXY_URL', selfHostedProxyUrl);
  const hostMinIntervalMs = new Map<string, number>(Object.entries(DEFAULT_CRAWLER_HOST_MIN_INTERVAL_MS));
  const rawHosts = environment.CRAWLER_HOST_MIN_INTERVAL_MS?.trim() ?? '';
  if (rawHosts) {
    for (const entry of rawHosts.split(',').map(item => item.trim()).filter(Boolean)) {
      const match = /^(.+):(\d+)$/.exec(entry);
      if (!match) throw new Error(`CRAWLER_HOST_MIN_INTERVAL_MS invalid entry: ${entry}`);
      const interval = Number(match[2]);
      if (!Number.isSafeInteger(interval) || interval < 1) throw new Error('CRAWLER_HOST_MIN_INTERVAL_MS must contain positive integer intervals');
      hostMinIntervalMs.set(match[1]!.toLowerCase().replace(/\.$/, ''), interval);
    }
  }
  return {
    proxies,
    selfHostedProxyUrl,
    targetIntervalMs,
    minIntervalMs,
    hostMinIntervalMs,
    concurrency: positiveEnv('CRAWLER_CONCURRENCY', 2, environment),
    hostConcurrency: positiveEnv('CRAWLER_HOST_CONCURRENCY', 2, environment),
  };
}

export function loadEnvironment(): void {
  if (!loadedEnvFile) return;
  process.loadEnvFile(loadedEnvFile);
}

loadEnvironment();
