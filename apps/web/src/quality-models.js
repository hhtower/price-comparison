import { useEffect, useState } from 'react';
import { qualityApi } from './quality-api.js';
import { validQualityUrl } from './quality-input.js';

export function useQualityModels(endpoint, apiKey, paused) {
  const [result, setResult] = useState({ phase: 'idle', models: [] });
  const [attempt, setAttempt] = useState(0);
  const address = endpoint.trim().replace(/\/+$/u, '');
  const key = apiKey.trim();
  useEffect(() => {
    if (paused || !validQualityUrl(address) || !key || key.length > 4096 || /[\x00-\x1f\x7f]/u.test(key)) {
      setResult({ phase: 'idle', models: [] });
      return;
    }
    const controller = new AbortController();
    setResult({ phase: 'loading', models: [] });
    const timer = setTimeout(async () => {
      try {
        const models = await qualityApi.models({ endpoint: address, apiKey: key }, controller.signal);
        if (!controller.signal.aborted) setResult({ phase: 'ready', models });
      } catch {
        if (!controller.signal.aborted) setResult({ phase: 'error', models: [] });
      }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [address, key, paused, attempt]);
  return { ...result, retry: () => setAttempt(value => value + 1) };
}
