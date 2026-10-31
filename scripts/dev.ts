import '../apps/api/src/config/env.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import concurrently from 'concurrently';
import { readAiStandardizationRuntimeStatus } from '../apps/api/src/ai/ai-standardization-features.js';
import { readOfficialReferenceConfig } from '../apps/api/src/official-reference/official-reference.config.js';
import { readAssistantConfig } from '../apps/api/src/assistant/assistant.config.js';

export function createDevPlan(environment: NodeJS.ProcessEnv = process.env) {
  const runtime = readAiStandardizationRuntimeStatus(environment);
  if (runtime.enabled && !runtime.providerConfigured) throw new Error(runtime.configError);

  const commands = [
    { name: 'api', command: 'tsx watch apps/api/src/main.ts' },
    { name: 'web', command: 'vite --config apps/web/vite.config.js --host' },
  ];
  if (runtime.configured) {
    commands.push({ name: 'ai', command: 'tsx watch apps/api/src/workers/ai.worker.ts' });
    if (runtime.incrementalEnabled) {
      commands.push({ name: 'standardization', command: 'tsx watch apps/api/src/workers/standardization-entrypoint.ts' });
    }
  }
  const reference = readOfficialReferenceConfig(environment);
  if (reference.enabled && reference.proxyUrl) commands.push({ name: 'official-reference', command: 'tsx watch apps/api/src/workers/official-reference.worker.ts' });
  const assistant = readAssistantConfig(environment);
  if (assistant.enabled) commands.push({ name: 'assistant', command: 'tsx watch apps/api/src/workers/assistant.worker.ts' });
  const aiNotice = runtime.configured
    ? `AI 任务处理已加入开发启动${runtime.incrementalEnabled ? '（含增量处理）' : ''}，将消费已有队列；模型请求按当前服务商计费。`
    : 'AI 标准化未启用，仅启动网页和 API；启用请设置 AI_STANDARDIZATION_ENABLED=true 并配置模型。';
  const notice = aiNotice + (reference.enabled && reference.proxyUrl ? ' 官网正价参考采集已加入启动，复用现有代理。' : ' 官网正价参考采集未启动，请配置 AI_PROXY_URL（或检查专用开关）。')
    + (assistant.enabled ? ' AI 导购 worker 已加入启动，将按当前服务商配置调用模型并可能产生费用。' : ' AI 导购助手未启用。');
  return { commands, notice };
}

async function main() {
  const plan = createDevPlan();
  console.log(`[dev] ${plan.notice}`);
  console.log('[dev] 修改源码后自动重启对应进程；修改 .env 后请重启 npm run dev。Ctrl+C 统一停止。');
  const { result } = concurrently(plan.commands, {
    prefix: 'name',
    killOthersOn: ['failure', 'success'],
  });
  await result.catch(() => { process.exitCode = 1; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(error => {
    console.error(`[dev] ${error instanceof Error ? error.message : '开发服务启动失败'}`);
    process.exitCode = 1;
  });
}
