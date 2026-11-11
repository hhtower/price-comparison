import { HttpException } from '@nestjs/common';
import { createRequire } from 'node:module';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { McpServer as McpServerInstance, CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MEMBERSHIP_GROUPS } from '@price-comparison/catalog/membership-policy';
import { CatalogService } from '../catalog/catalog.service.js';
import { McpAccess } from './mcp-access.js';

const require = createRequire(import.meta.url);
// Avoid the SDK ESM loader stall in Windows tsx watch.
const { McpServer } = require('@modelcontextprotocol/server') as typeof import('@modelcontextprotocol/server');
const { NodeStreamableHTTPServerTransport } = require('@modelcontextprotocol/node') as typeof import('@modelcontextprotocol/node');

const snapshotWarning = 'Prices and stock are captured snapshots, not live guarantees. Compare only the same currency and duration; check quantity, priceStatus, stale and capture/verification times before recommending a purchase.';
const id = z.string().regex(/^[1-9][0-9]{0,18}$/u).refine(value => BigInt(value) < 2n ** 63n, 'Invalid product ID');
const currency = z.string().regex(/^[A-Z]{3}$/u);
const money = z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/u);
const filters = {
  currency: currency.optional(),
  priceMin: money.optional(),
  priceMax: money.optional(),
  tags: z.array(z.strictObject({ name: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(250) })).max(50).optional(),
  warrantyDaysMin: z.number().int().min(1).max(36500).optional(),
  membershipKinds: z.array(z.enum(MEMBERSHIP_GROUPS)).min(1).max(MEMBERSHIP_GROUPS.length).optional()
    .describe('AI membership query groups, independent of delivery tags; unclassified selects offers without a valid classification. Explicit groups override newcomer scope.'),
  newcomer: z.boolean().optional()
    .describe('When true, AI memberships must be account or top_up; other products are unaffected. No rental or short-term fallback.'),
};
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function toolResult(load: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    const structuredContent = { ...await load(), snapshotWarning };
    const text = JSON.stringify(structuredContent);
    if (Buffer.byteLength(text) > 128 * 1024) return toolError('Result too large. Narrow the filters or reduce the page size.');
    return { content: [{ type: 'text', text }], structuredContent };
  } catch (error) {
    return toolError(error instanceof HttpException && error.getStatus() === 400
      ? 'Invalid catalog filters.' : 'Catalog data is unavailable. Try again later.');
  }
}

function createServer(catalog: CatalogService): McpServerInstance {
  const server = new McpServer({ name: 'price-comparison', version: '1.0.0' }, { maxToolInputElements: 200 });
  server.registerTool('search_products', {
    description: `Search public products with cursor pagination. Use get_product_offers for full paginated quotes. ${snapshotWarning}`,
    annotations,
    inputSchema: z.strictObject({
      q: z.string().max(500).optional(),
      platform: z.string().max(100).optional(),
      cursor: z.string().max(2048).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      ...filters,
    }),
  }, input => toolResult(async () => {
    const page = await catalog.getCatalog(input);
    return {
      items: page.items.map(({ id, name, platform, membershipGroups, standardProductId, shopCount, productCount, latestCapturedAt }) =>
        ({ id, name, platform, membershipGroups, standardProductId, shopCount, productCount, latestCapturedAt })),
      total: page.total, nextCursor: page.nextCursor ?? null,
      nextExpiryAt: page.nextExpiryAt, appliedQuery: page.appliedQuery,
    };
  }));
  server.registerTool('get_product_offers', {
    description: `Get complete public offers, not search previews. detailPage is zero-based (0 to 1000); pageSize is 1 to 50. Price filters default to CNY when currency is omitted. ${snapshotWarning}`,
    annotations,
    inputSchema: z.strictObject({
      standardProductId: id,
      detailPage: z.number().int().min(0).max(1000).default(0),
      pageSize: z.number().int().min(1).max(50).default(20),
      offerSort: z.enum(['price', 'priceDesc', 'updated']).optional(),
      ...filters,
    }),
  }, ({ standardProductId, detailPage, pageSize, ...filters }) => toolResult(async () => {
    const product = await catalog.getProduct(standardProductId);
    if (!product || product.mergedIntoId) throw new Error('Unavailable product');
    const publicProduct = ({ id, name, platform, kind }: typeof product) => ({ id, name, platform, kind });
    const page = await catalog.getCatalog({
      standardProductId, detailKind: 'offers', detailPage, detailPageSize: pageSize, limit: 1, ...filters,
    });
    const item = page.items[0];
    const detail = item?.detail;
    if (item && detail?.kind !== 'offers') throw new Error('Missing offer detail');
    return {
      product: publicProduct(product),
      offers: detail?.kind === 'offers' ? detail.entries : [],
      page: detailPage, pageSize, total: detail?.total ?? 0,
      nextPage: detail && (detailPage + 1) * pageSize < detail.total ? detailPage + 1 : null,
      nextExpiryAt: page.nextExpiryAt,
    };
  }));
  server.registerTool('get_price_history', {
    description: `Get 30 days of verified daily price snapshots for a public product, optionally restricted to a source productId or membershipKinds. History is grouped using each SKU's current feature; AI memberships without a valid classification use the unclassified group. Currency defaults to CNY. Daily minima may represent different offers within the selected scope. ${snapshotWarning}`,
    annotations,
    inputSchema: z.strictObject({ standardProductId: id, productId: id.optional(), currency: currency.default('CNY'),
      membershipKinds: filters.membershipKinds, newcomer: filters.newcomer }),
  }, ({ standardProductId, productId, currency, ...scope }) => toolResult(async () => {
    const history = await catalog.getPriceHistory(standardProductId, productId, currency, scope);
    if (!history) throw new Error('Unavailable product');
    return { ...history };
  }));
  return server;
}

function publicOrigin(): string | undefined {
  try {
    const url = new URL(process.env.PUBLIC_SITE_URL ?? '');
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      ? url.origin : undefined;
  } catch { return undefined; }
}

function rpcError(message: string) {
  return { jsonrpc: '2.0', id: null, error: { code: -32000, message } };
}

export function registerMcpEndpoint(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();
  const catalog = app.get(CatalogService);
  const access = app.get(McpAccess);
  const allowedOrigin = publicOrigin();
  const active = new Map<McpServerInstance, () => void>();
  // Fastify finishes in-flight HTTP handlers before this final drain and database shutdown.
  fastify.addHook('onClose', async () => { await access.beforeApplicationShutdown(); });
  fastify.addHook('preClose', async () => {
    await Promise.all([...active].map(async ([server, disconnect]) => {
      disconnect();
      await server.close();
    }));
  });
  fastify.all('/v1/mcp', {
    bodyLimit: 64 * 1024,
    logLevel: 'silent',
    onRequest: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const origin = request.headers.origin;
      if (origin !== undefined && (!allowedOrigin || origin !== allowedOrigin)) {
        return reply.code(403).send(rpcError('Forbidden origin.'));
      }
      try {
        const key = await access.authenticate(request.headers.authorization);
        await access.admitKey(key.id, key.requestsPerMinute, reply);
      } catch (error) {
        const status = error instanceof HttpException ? error.getStatus() : 503;
        if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
        return reply.code(status).send(rpcError(status === 401 ? 'Unauthorized.'
          : status === 429 ? 'Too many requests.' : 'Request unavailable.'));
      }
    },
    errorHandler: (error, _request, reply) => {
      const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      void reply.code(status).header('Cache-Control', 'no-store').send(rpcError('Invalid MCP request.'));
    },
  }, async (request, reply) => {
    if (request.method !== 'POST') return reply.code(405).header('Allow', 'POST').send(rpcError('Method not allowed.'));
    // One request per transport keeps authentication and protocol state isolated.
    if (Array.isArray(request.body)) return reply.code(400).send(rpcError('Batch requests are not supported.'));
    const server = createServer(catalog);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let closing: Promise<void> | undefined;
    const close = () => {
      active.delete(server);
      return closing ??= server.close();
    };
    active.set(server, () => reply.raw.destroy());
    reply.raw.once('close', () => { void close().catch(() => {}); });
    try {
      await server.connect(transport);
      // Fastify consumed the body; the SDK must receive it explicitly.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch {
      if (!reply.raw.headersSent && !reply.raw.destroyed) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.raw.end(JSON.stringify(rpcError('MCP service unavailable.')));
      } else if (!reply.raw.writableEnded) reply.raw.destroy();
    } finally {
      await close();
    }
  });
}
