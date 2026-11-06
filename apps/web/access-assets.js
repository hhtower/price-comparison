import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const files = new Map([
  ...['INSTALL.md', 'SKILL.md', 'references/setup.md', 'scripts/query.mjs']
    .map(path => [`assets/skills/price-comparison/${path}`, `skills/price-comparison/${path}`]),
  ['assets/access/skill.md', 'docs/skill.md'],
  ['assets/access/mcp.md', 'docs/mcp.md'],
].map(([asset, source]) => [asset, fileURLToPath(new URL('../../' + source, import.meta.url))]));

export function accessAssets() {
  let building = false;
  return {
    name: 'agent-access-assets',
    configResolved(config) { building = config.command === 'build'; },
    buildStart() {
      if (!building) return;
      for (const [fileName, source] of files) {
        this.addWatchFile(source);
        this.emitFile({ type: 'asset', fileName, source: readFileSync(source) });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const source = files.get((request.url ?? '').split('?')[0].slice(1));
        if (!source || !['GET', 'HEAD'].includes(request.method)) return next();
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-cache');
        response.end(request.method === 'HEAD' ? undefined : readFileSync(source));
      });
    },
  };
}
