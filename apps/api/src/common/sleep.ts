import { setTimeout } from 'node:timers/promises';

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  try { await setTimeout(ms, undefined, { signal }); }
  catch (error) { throw signal?.aborted ? signal.reason : error; }
}
