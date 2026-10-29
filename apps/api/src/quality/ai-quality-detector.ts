import { createStreamingCall, type StreamingCall, type StreamingInput, type StreamingResult } from '../ai/llm-runtime.js';
import type { AiQualityInput, QualityAttempt, QualityAttemptOutcome, QualityDetector, QualityItemResult, QualityProgress } from './quality.types.js';
import { answerSchema, candyPrompt, codeSchema, colorSchema, exactObject, instructionMessages, pdfReference, redImage, reference, structuredSchema } from './ai-quality-probes.js';
import { compareBuiltinFingerprint, createFingerprintChallenges, supportsBuiltinFingerprint, validFingerprintSample } from './ai-quality-baselines.js';

export interface AiQualityDetectorOptions {
  fetchImpl?: typeof fetch; environment?: NodeJS.ProcessEnv;
  timeoutMs?: number; maxOutputBytes?: number;
}
const pass = (id: string, summary: string, score = 100): QualityItemResult => ({ id, status: 'pass', score, summary });
const risk = (id: string, summary = '检测请求失败或返回结果不符合要求。', score = 0): QualityItemResult => ({ id, status: 'risk', score, summary });
const cancelled = (id: string): QualityItemResult => ({ id, status: 'cancelled', score: null, summary: '检测已取消，可重新测试此项。' });
const unrun = (id: string, summary: string, reason: 'unsupported' | 'insufficient-samples'): QualityItemResult => ({ id, status: 'unrun', score: null, summary, reason });
const user = (content: string): StreamingInput['messages'] => [{ role: 'user', content }];
class InvalidResponse extends Error {}
function failureOutcome(error: unknown): QualityAttemptOutcome {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'APIConnectionTimeoutError' || /timeout|timed out/i.test(error.message))) return 'timeout';
  if (error instanceof InvalidResponse || error instanceof SyntaxError || (error instanceof Error && /^(AI response |AI output |AI tool response )/.test(error.message))) return 'invalid-response';
  return 'request-error';
}
/** Preserve exact benchmark scoring, but distinguish invalid shapes from valid wrong answers. */
function observedObject(content: string, expected: Record<string, unknown>): boolean {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new InvalidResponse(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidResponse();
  const actual = value as Record<string, unknown>;
  if (Object.keys(actual).length !== Object.keys(expected).length || Object.entries(expected).some(([key, wanted]) => typeof actual[key] !== typeof wanted || (typeof wanted === 'number' && Number.isInteger(wanted) && !Number.isInteger(actual[key])))) throw new InvalidResponse();
  return exactObject(content, expected);
}

function generationSpeed(response: StreamingResult): number | null {
  if (!response.usage || response.firstContentMs === null || response.contentChunks < 2 || response.content.length < 128) return null;
  const durationMs = response.responseMs - response.firstContentMs;
  const visibleTokens = response.usage.completionTokens - (response.usage.reasoningTokens ?? 0);
  // A buffered frame, tiny answer or sub-clock interval does not establish throughput.
  if (durationMs < 100 || visibleTokens < 32) return null;
  return visibleTokens / (durationMs / 1000);
}

export function createAiQualityDetector(options: AiQualityDetectorOptions = {}): QualityDetector<AiQualityInput> {
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? Number(environment.QUALITY_AI_TIMEOUT_MS ?? 30000);
  const maxOutputBytes = options.maxOutputBytes ?? Number(environment.QUALITY_AI_MAX_OUTPUT_BYTES ?? 65536);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid quality AI runtime configuration');

  return async (input, itemIds, signal, onItem, onProgress = () => {}) => {
    let network: { fetch: typeof fetch; close(): Promise<void> } | undefined;
    let primary: StreamingCall | undefined;
    if (!Number.isSafeInteger(input.runs) || input.runs < 1 || input.runs > 5) throw new Error('检测次数必须为 1 至 5');
    const runs = input.runs;
    const results: QualityItemResult[] = [];
    let currentId = itemIds[0]; let requestNumber = 0; let requestTotal = runs; let stage: QualityProgress['stage'] = 'probe';
    const basicAttempts: QualityAttempt[] = []; const baselineAttempts: QualityAttempt[] = [];
    const environmentFor = (endpoint: string, apiKey: string): NodeJS.ProcessEnv => ({ AI_BASE_URL: endpoint, AI_API_KEY: apiKey, AI_TIMEOUT_MS: String(timeoutMs), AI_MAX_OUTPUT_BYTES: String(maxOutputBytes) });
    const call = async (request: Omit<StreamingInput, 'model' | 'signal'>) => {
      signal.throwIfAborted();
      if (!network) {
        if (options.fetchImpl) network = { fetch: options.fetchImpl, close: async () => {} };
        else {
          const { createQualityFetch } = await import('./quality-network.js');
          network = await createQualityFetch(undefined, { serverProxyUrl: environment.AI_PROXY_URL, signal });
        }
      }
      if (!primary) primary = createStreamingCall(environmentFor(input.endpoint, input.apiKey), network.fetch);
      signal.throwIfAborted();
      onProgress({ itemId: currentId, stage, attempt: ++requestNumber, total: requestTotal, startedAt: new Date().toISOString() });
      return primary({ ...request, model: input.model, signal, includeUsage: true });
    };
    let basics: Promise<StreamingResult[]> | undefined;
    const basicResponses: StreamingResult[] = [];
    const basic = () => basics ??= (async () => {
      const repetitions = runs;
      stage = 'measurement'; requestNumber = 0; requestTotal = repetitions;
      const prompt = itemIds.includes('latency')
        ? 'Output the integers from 1 through 64, in ascending order, separated by a single space. Do not add any explanation.'
        : 'Output exactly READY with no explanation.';
      for (let i = 0; i < repetitions; i++) {
        try { basicResponses.push(await call({ messages: user(prompt) })); basicAttempts.push({ run: i + 1, outcome: 'pass' }); }
        catch (error) { signal.throwIfAborted(); basicAttempts.push({ run: i + 1, outcome: failureOutcome(error) }); throw error; }
      }
      return basicResponses;
    })();
    let calibration: Promise<ReturnType<typeof compareBuiltinFingerprint> | null> | undefined;
    const calibrated = () => calibration ??= (async () => {
      if (!supportsBuiltinFingerprint(input.model)) return null;
      const repetitions = runs;
      const challenges = createFingerprintChallenges(repetitions);
      stage = 'baseline'; requestNumber = 0; requestTotal = repetitions;
      const outputs: Array<{ text: string; expected_count: number }> = [];
      for (const challenge of challenges) {
        try {
          const response = await call({ messages: user(challenge.prompt) });
          if (response.responseModels.length !== 1 || response.responseModel !== input.model || !validFingerprintSample(response.content, challenge.expected_count)) throw new InvalidResponse();
          outputs.push({ text: response.content, expected_count: challenge.expected_count });
          baselineAttempts.push({ run: baselineAttempts.length + 1, outcome: 'pass' });
        } catch (error) {
          signal.throwIfAborted(); baselineAttempts.push({ run: baselineAttempts.length + 1, outcome: failureOutcome(error) }); throw error;
        }
      }
      return compareBuiltinFingerprint(input.model, outputs);
    })();
    const repeated = async (id: string, probe: () => Promise<boolean>, summary: string, count = runs) => {
      let passed = 0; const attempts: QualityAttempt[] = [];
      stage = 'probe'; requestNumber = 0; requestTotal = count * (id === 'multi-turn' ? 2 : 1);
      for (let i = 0; i < count; i++) {
        signal.throwIfAborted();
        try { const valid = await probe(); if (valid) passed++; attempts.push({ run: i + 1, outcome: valid ? 'pass' : 'mismatch' }); }
        catch (error) { signal.throwIfAborted(); attempts.push({ run: i + 1, outcome: failureOutcome(error) }); }
      }
      const score = Math.round(100 * passed / count);
      return { ...(passed === count ? pass(id, summary, score) : risk(id, '重复检测中出现失败、异常或不一致。', score)), evidence: { attempts } };
    };
    const checkObject = async (prompt: string, expected: Record<string, unknown>, schema: Record<string, unknown>) => observedObject((await call({ messages: user(prompt), responseFormat: schema })).content, expected);

    const check = async (id: string): Promise<QualityItemResult> => {
      switch (id) {
        case 'connectivity': {
          const responses = await basic();
          return responses.every(response => response.content.trim().length > 0) ? pass(id, '服务已返回完整响应。') : risk(id, '服务未返回有效内容。');
        }
        case 'model-identity': {
          const valid = (await basic()).every(response => response.responseModel === input.model && response.responseModels.length === 1);
          return valid ? pass(id, '响应声明的模型与请求一致，不能单独证明来源。') : risk(id, '响应声明的模型缺失或与请求不一致。');
        }
        case 'streaming': {
          const valid = (await basic()).every(response => response.responseId && response.responseModel && response.chunkCount >= 1 && response.finishReason === 'stop' && response.contentChunks > 0);
          return valid ? pass(id, '流式事件与响应字段完整。') : risk(id, '流式事件或响应字段不完整。');
        }
        case 'token-usage': {
          const valid = (await basic()).every(response => response.usage && response.usage.promptTokens > 0 && response.usage.completionTokens > 0);
          return valid ? pass(id, '用量字段完整且数值关系有效。') : risk(id, '缺少有效的 Token 用量字段。');
        }
        case 'latency': {
          const responses = await basic();
          const speeds = responses.map(generationSpeed).filter((speed): speed is number => speed !== null);
          const allSpeedsObserved = speeds.length === responses.length;
          const validTimings = responses.every(response => response.firstContentMs !== null && response.firstContentMs <= 5000 && response.responseMs <= 30000);
          const validSpeeds = speeds.every(speed => speed >= 5);
          if (validTimings && validSpeeds) {
            return pass(id, allSpeedsObserved ? '首 Token、总耗时与生成速度处于可用范围。'
              : speeds.length ? '响应时间与已测速度可用；部分响应未评价生成速度。'
                : '响应时间可用；观测不足，未评价生成速度。');
          }
          return risk(id, allSpeedsObserved ? '首 Token、总耗时或生成速度存在异常。'
            : speeds.length ? '响应时间或已测速度存在异常；部分响应未评价生成速度。'
              : '首 Token或总耗时存在异常；观测不足，未评价生成速度。');
        }
        case 'fingerprint-match': {
          const observed = await calibrated();
          if (!observed) return unrun(id, '内置指纹库暂未覆盖此模型，尚不能完成指纹对照。', 'unsupported');
          const score = observed.fingerprint;
          const consistent = observed.fingerprintMatches;
          const summary = consistent ? '与内置目标模型指纹匹配'
              : observed.predictedModel !== input.model ? '内置指纹更接近 ' + observed.predictedModel : '内置目标模型指纹的匹配证据不足';
          return (consistent ? pass : risk)(id, summary + '；仅作候选库内统计参考，不能证明模型来源。', score);
        }
        case 'iq-test': return repeated(id, () => checkObject(candyPrompt, { answer: 21 }, answerSchema('integer')), '智商测试答案符合预期。');
        case 'math-reasoning': return repeated(id, () => checkObject('Compute 101 multiplied by 103. Return only a JSON object with integer answer.', { answer: 10403 }, answerSchema('integer')), '数学推理答案符合预期。');
        case 'logic-reasoning': return repeated(id, () => checkObject('A, B and C occupy distinct positions in a line. A is before B, and B is before C. Which symbol is in the middle? Return only JSON with string answer.', { answer: 'B' }, answerSchema('string')), '逻辑推理答案符合预期。');
        case 'instruction-following': return repeated(id, async () => (await call({ messages: instructionMessages })).content === 'READY-7', '指令优先级与输出约束符合预期。');
        case 'structured-output': return repeated(id, () => checkObject('Return only JSON with label equal to ok and numeric count equal to 3.', { label: 'ok', count: 3 }, structuredSchema), '结构化输出通过字段与类型检查。');
        case 'tool-calling': return repeated(id, async () => {
          const response = await call({ messages: user('Call record_quality_sample with code Q7 and value 17. Do not explain.'), tools: [{ type: 'function', function: { name: 'record_quality_sample', strict: true, parameters: { type: 'object', properties: { code: { type: 'string' }, value: { type: 'integer' } }, required: ['code', 'value'], additionalProperties: false } } }], toolChoice: { type: 'function', function: { name: 'record_quality_sample' } } });
          const tool = response.toolCalls[0];
          if (response.finishReason !== 'tool_calls' || response.toolCalls.length !== 1) throw new InvalidResponse();
          return tool.function.name === 'record_quality_sample' && observedObject(tool.function.arguments, { code: 'Q7', value: 17 });
        }, '工具调用与参数结构符合预期。');
        case 'long-context': return repeated(id, async () => {
          const code = reference('QL');
          const filler = 'The following material is irrelevant; retain only the unique reference.\n'.repeat(200);
          return checkObject(`${filler}\nREFERENCE=${code}\n${filler}\nReturn only JSON with code equal to the unique reference.`, { code }, codeSchema);
        }, '长文本中的目标信息提取正确。');
        case 'multimodal': return repeated(id, async () => {
          const response = await call({ messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the solid color in this image? Return JSON with color as a lowercase English basic color.' }, { type: 'image_url', image_url: { url: redImage } }] }], responseFormat: colorSchema });
          return observedObject(response.content, { color: 'red' });
        }, '图像内容识别符合预期。');
        case 'pdf': return repeated(id, async () => {
          const code = reference('QP');
          const response = await call({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the Reference value from the PDF. Return only JSON with code equal to that value.' }, { type: 'file', file: { filename: 'quality-reference.pdf', file_data: pdfReference(code) } }] }], responseFormat: codeSchema });
          return observedObject(response.content, { code });
        }, 'PDF 文件内容提取符合预期。');
        case 'multi-turn': return repeated(id, async () => {
          const code = reference('QT');
          const messages = user(`Remember REFERENCE=${code}. Reply only ACK.`);
          const first = await call({ messages });
          if (first.content !== 'ACK') return false;
          messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: 'Return only JSON with code equal to the remembered reference.' });
          return observedObject((await call({ messages, responseFormat: codeSchema })).content, { code });
        }, '多轮对话中的信息保持一致。');
        case 'stability': return runs < 2
          ? unrun(id, '至少需要两次独立观测才能评价请求稳定性，请增加检测次数。', 'insufficient-samples')
          : repeated(id, async () => (await call({ messages: instructionMessages })).content === 'READY-7', '多次独立请求均完成且结果一致。');
        default: return unrun(id, '此检测项目尚未支持。', 'unsupported');
      }
    };
    try {
      for (const id of itemIds) {
        currentId = id;
        let result: QualityItemResult;
        if (signal.aborted) result = cancelled(id);
        else { try { result = await check(id); } catch { result = signal.aborted ? cancelled(id) : risk(id); } }
        if (result.status !== 'cancelled' && basics && ['connectivity', 'model-identity', 'streaming', 'token-usage', 'latency'].includes(id)) {
          const responses = basicResponses;
          const observed = (response: StreamingResult) => id === 'connectivity' ? response.content.trim().length > 0 : id === 'model-identity' ? response.responseModel === input.model && response.responseModels.length === 1 : id === 'streaming' ? Boolean(response.responseId && response.responseModel && response.chunkCount >= 1 && response.finishReason === 'stop' && response.contentChunks > 0) : id === 'token-usage' ? Boolean(response.usage && response.usage.promptTokens > 0 && response.usage.completionTokens > 0) : response.firstContentMs !== null && response.firstContentMs <= 5000 && response.responseMs <= 30000 && (generationSpeed(response) ?? 5) >= 5;
          result.evidence = { attempts: basicAttempts.map((attempt, index) => ({ ...attempt, outcome: responses[index] ? observed(responses[index]) ? 'pass' : 'mismatch' : attempt.outcome })), ...(id === 'latency' && responses.length ? { measurements: responses.map((response, index) => ({ run: index + 1, firstTokenMs: response.firstContentMs, responseMs: response.responseMs, tokensPerSecond: generationSpeed(response) })) } : {}) };
        }
        if (result.status !== 'cancelled' && baselineAttempts.length && id === 'fingerprint-match') result.evidence = { attempts: baselineAttempts.map(attempt => ({ ...attempt })) };
        results.push(result);
        onItem(result);
      }
      return results;
    } finally { await network?.close(); }
  };
}
