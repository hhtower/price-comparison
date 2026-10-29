export interface AiStandardizationFeatures {
  readonly standardizationEnabled: boolean;
  readonly incrementalStandardizationEnabled: boolean;
  readonly tagExtractionEnabled: boolean;
}

export interface AiStandardizationRuntimeStatus {
  readonly enabled: boolean;
  readonly incrementalEnabled: boolean;
  readonly tagExtractionEnabled: boolean;
  readonly providerConfigured: boolean;
  readonly configured: boolean;
  readonly configError: string;
  readonly model: string;
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function readAiStandardizationFeatures(
  environment: NodeJS.ProcessEnv = process.env,
): AiStandardizationFeatures {
  const standardizationEnabled = enabled(environment.AI_STANDARDIZATION_ENABLED);
  return {
    standardizationEnabled,
    incrementalStandardizationEnabled: standardizationEnabled
      && enabled(environment.AI_INCREMENTAL_STANDARDIZATION_ENABLED),
    tagExtractionEnabled: enabled(environment.AI_TAG_EXTRACTION_ENABLED ?? 'true'),
  };
}

export function readAiStandardizationRuntimeStatus(
  environment: NodeJS.ProcessEnv = process.env,
): AiStandardizationRuntimeStatus {
  const features = readAiStandardizationFeatures(environment);
  const model = environment.AI_MODEL?.trim() ?? '';
  const providerConfigured = Boolean(
    environment.AI_BASE_URL?.trim()
    && environment.AI_API_KEY?.trim()
    && model,
  );
  const configured = features.standardizationEnabled && providerConfigured;
  return {
    enabled: features.standardizationEnabled,
    incrementalEnabled: features.incrementalStandardizationEnabled,
    tagExtractionEnabled: features.tagExtractionEnabled,
    providerConfigured,
    configured,
    configError: !features.standardizationEnabled
      ? 'AI 商品标准化功能未启用'
      : providerConfigured
        ? ''
        : 'AI_BASE_URL、AI_API_KEY 和 AI_MODEL 必须完整配置',
    model,
  };
}

export function requireAiStandardizationWorker(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const runtime = readAiStandardizationRuntimeStatus(environment);
  if (!runtime.enabled) {
    throw new Error('AI worker requires AI_STANDARDIZATION_ENABLED=true');
  }
  if (!runtime.providerConfigured) {
    throw new Error('AI worker requires AI_BASE_URL, AI_API_KEY, and AI_MODEL');
  }
}

export function requireIncrementalStandardizationWorker(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const features = readAiStandardizationFeatures(environment);
  if (!features.standardizationEnabled) {
    throw new Error('Incremental standardization worker requires AI_STANDARDIZATION_ENABLED=true');
  }
  if (!features.incrementalStandardizationEnabled) {
    throw new Error('Incremental standardization worker requires AI_INCREMENTAL_STANDARDIZATION_ENABLED=true');
  }
  if (!readAiStandardizationRuntimeStatus(environment).providerConfigured) {
    throw new Error('Incremental standardization worker requires AI_BASE_URL, AI_API_KEY, and AI_MODEL');
  }
}
