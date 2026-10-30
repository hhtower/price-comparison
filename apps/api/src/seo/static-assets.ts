import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const CONTENT_TYPES: Record<string, string> = {
  js: 'application/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml', woff2: 'font/woff2',
};

export function registerStaticAssets(server: FastifyInstance, clientRoot: string): void {
  const root = resolve(clientRoot, 'assets');
  server.get('/assets/*', async (request, reply) => {
    const relative = String((request.params as { '*': string })['*'] ?? '');
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) return reply.code(404).send();
    let info;
    try { info = await stat(file); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return reply.code(404).send();
      throw error;
    }
    if (!info.isFile()) return reply.code(404).send();
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    reply.header('Cache-Control', /-[\w-]{8,}\.[^.]+$/u.test(relative)
      ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
    reply.header('ETag', etag).header('Last-Modified', info.mtime.toUTCString());
    const match = request.headers['if-none-match'];
    const since = request.headers['if-modified-since'];
    const unmodified = match !== undefined
      ? match.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//u, '') === etag.slice(2))
      : since !== undefined && Math.floor(info.mtimeMs / 1_000) * 1_000 <= Date.parse(since);
    if (unmodified) return reply.code(304).send();
    return reply.type(CONTENT_TYPES[extname(file).slice(1)] ?? 'application/octet-stream').send(createReadStream(file));
  });
}
