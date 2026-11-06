import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const tools = ['search_products', 'get_product_offers', 'get_price_history'];
const protocolVersion = '2025-11-25';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class AccessError extends Error {}

async function configuration() {
  let url = process.env.PRICE_COMPARISON_URL;
  let key = process.env.PRICE_COMPARISON_API_KEY;
  // Harness credentials are not automatically exported to shell subprocesses.
  if ((!url || !key) && process.env.DSH_SHELL === '1' && process.env.DSH_HOME) {
    let text;
    try { text = await readFile(join(process.env.DSH_HOME, '.env'), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new AccessError('Cannot read the Harness environment configuration.');
    }
    if (text !== undefined) {
      const native = parseEnv(text);
      url ||= native.PRICE_COMPARISON_URL;
      key ||= native.PRICE_COMPARISON_API_KEY;
    }
  }
  url ||= 'https://price.yufu.pub';
  if (!key) throw new AccessError('Run the price-comparison setup skill to configure the API key in your agent.');
  if (!/^mcp_[A-Za-z0-9_-]{43}$/u.test(key)) throw new AccessError('Invalid API key format. Use the key issued by the access page.');
  let origin;
  try { origin = new URL(url); }
  catch { throw new AccessError('Invalid site URL. Use the origin shown on the access page.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local))
    || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new AccessError('Use an HTTPS site origin without a path, credentials, query or fragment. HTTP is allowed only on loopback.');
  }
  return { endpoint: new URL('/api/mcp', origin), key };
}

async function main() {
  const [command, input = '{}', ...extra] = process.argv.slice(2);
  if (command === '--help') {
    console.log('Usage: node query.mjs check|tools|search_products|get_product_offers|get_price_history [JSON object]');
    return;
  }
  if (extra.length || !['check', 'tools', ...tools].includes(command)) throw new AccessError('Unknown command. Run with --help.');
  let args;
  try { args = JSON.parse(input); }
  catch { throw new AccessError('Arguments must be a JSON object.'); }
  if (!object(args)) throw new AccessError('Arguments must be a JSON object.');
  const { endpoint, key } = await configuration();
  const signal = AbortSignal.timeout(15000);
  let id = 0;
  async function rpc(method, params, notification = false) {
    const requestId = notification ? undefined : ++id;
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message = response.status === 401 ? 'API key is invalid, expired or revoked. Check the shared access page.'
        : response.status === 429 ? 'Shared request limit reached. Wait before trying again.'
          : 'The pricing service is unavailable. Check the site URL and try later.';
      throw new AccessError(message);
    }
    if (notification) { await response.body?.cancel(); return; }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      throw new AccessError('Expected a JSON response from the pricing service.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 256 * 1024) throw new AccessError('Response too large. Narrow the filters or page size.');
      chunks.push(chunk);
    }
    let message;
    try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new AccessError('The pricing service returned invalid JSON.'); }
    if (!object(message) || message.jsonrpc !== '2.0' || message.id !== requestId || message.error || !object(message.result)) {
      throw new AccessError('The pricing service returned an invalid or failed response.');
    }
    return message.result;
  }
  const initialized = await rpc('initialize', { protocolVersion, capabilities: {},
    clientInfo: { name: 'price-comparison-skill', version: '1.0.0' } });
  if (initialized.protocolVersion !== protocolVersion) throw new AccessError('Unsupported service protocol version.');
  await rpc('notifications/initialized', undefined, true);
  let result;
  if (command === 'check' || command === 'tools') {
    result = await rpc('tools/list');
    if (!Array.isArray(result.tools) || !tools.every(name => result.tools.some(tool => tool?.name === name))) {
      throw new AccessError('The service does not provide the required pricing tools.');
    }
    if (command === 'check') result = { ok: true, tools };
  } else {
    const response = await rpc('tools/call', { name: command, arguments: args });
    if (response.isError || !object(response.structuredContent)) {
      throw new AccessError('Price query failed. Check tool arguments with the tools command; do not use this result as a quote.');
    }
    result = response.structuredContent;
  }
  console.log(JSON.stringify(result).replaceAll(key, '[redacted]'));
}

main().catch(error => {
  const message = error instanceof AccessError ? error.message
    : 'Request failed or timed out. Check connectivity and the configured site; redirects are not followed.';
  console.error(`price-comparison: ${message}`);
  process.exitCode = 1;
});
