import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requireAiStandardizationWorker,
  requireIncrementalStandardizationWorker,
  readAiStandardizationFeatures,
  readAiStandardizationRuntimeStatus,
} from '../src/ai/ai-standardization-features.js';
import { AiService } from '../src/ai/ai.service.js';

test('AI standardization features are disabled unless explicitly enabled', () => {
  assert.deepEqual(readAiStandardizationFeatures({}), {
    standardizationEnabled: false,
    incrementalStandardizationEnabled: false,
    tagExtractionEnabled: true,
  });
  assert.deepEqual(readAiStandardizationFeatures({
    AI_STANDARDIZATION_ENABLED: 'false',
    AI_INCREMENTAL_STANDARDIZATION_ENABLED: 'true',
  }), {
    standardizationEnabled: false,
    incrementalStandardizationEnabled: false,
    tagExtractionEnabled: true,
  });
  assert.deepEqual(readAiStandardizationFeatures({
    AI_STANDARDIZATION_ENABLED: ' TRUE ',
    AI_INCREMENTAL_STANDARDIZATION_ENABLED: 'true',
  }), {
    standardizationEnabled: true,
    incrementalStandardizationEnabled: true,
    tagExtractionEnabled: true,
  });
});

test('runtime status reports a disabled feature even when provider credentials exist', () => {
  const credentials = {
    AI_BASE_URL: 'https://model.invalid/v1',
    AI_API_KEY: 'secret',
    AI_MODEL: 'model',
  };
  assert.deepEqual(readAiStandardizationRuntimeStatus(credentials), {
    enabled: false,
    incrementalEnabled: false,
    tagExtractionEnabled: true,
    providerConfigured: true,
    configured: false,
    configError: 'AI 商品标准化功能未启用',
    model: 'model',
  });
  assert.deepEqual(readAiStandardizationRuntimeStatus({
    ...credentials,
    AI_STANDARDIZATION_ENABLED: 'true',
    AI_INCREMENTAL_STANDARDIZATION_ENABLED: 'true',
  }), {
    enabled: true,
    incrementalEnabled: true,
    tagExtractionEnabled: true,
    providerConfigured: true,
    configured: true,
    configError: '',
    model: 'model',
  });
});

test('tag extraction defaults to enabled and can be explicitly disabled', () => {
  assert.equal(readAiStandardizationFeatures({}).tagExtractionEnabled, true);
  for (const value of ['true', ' TRUE ', 'false', ' FALSE ', 'invalid', '']) {
    const expected = value.trim().toLowerCase() === 'true';
    const environment = { AI_TAG_EXTRACTION_ENABLED: value };
    assert.equal(readAiStandardizationFeatures(environment).tagExtractionEnabled, expected);
    assert.equal(readAiStandardizationRuntimeStatus(environment).tagExtractionEnabled, expected);
  }
});

test('worker guards reject disabled or partially enabled configurations', () => {
  assert.throws(
    () => requireAiStandardizationWorker({}),
    /AI_STANDARDIZATION_ENABLED=true/u,
  );
  assert.throws(() => requireAiStandardizationWorker({
    AI_STANDARDIZATION_ENABLED: 'true',
  }), /AI_BASE_URL.*AI_API_KEY.*AI_MODEL/u);
  assert.throws(
    () => requireIncrementalStandardizationWorker({
      AI_INCREMENTAL_STANDARDIZATION_ENABLED: 'true',
    }),
    /AI_STANDARDIZATION_ENABLED=true/u,
  );
  assert.throws(
    () => requireIncrementalStandardizationWorker({
      AI_STANDARDIZATION_ENABLED: 'true',
    }),
    /AI_INCREMENTAL_STANDARDIZATION_ENABLED=true/u,
  );
  assert.doesNotThrow(() => requireIncrementalStandardizationWorker({
    AI_STANDARDIZATION_ENABLED: 'true',
    AI_INCREMENTAL_STANDARDIZATION_ENABLED: 'true',
    AI_BASE_URL: 'https://model.invalid/v1',
    AI_API_KEY: 'secret',
    AI_MODEL: 'model',
  }));
  assert.doesNotThrow(() => requireAiStandardizationWorker({
    AI_STANDARDIZATION_ENABLED: 'true',
    AI_BASE_URL: 'https://model.invalid/v1',
    AI_API_KEY: 'secret',
    AI_MODEL: 'model',
  }));
});

test('manual AI job creation is rejected before repository access while standardization is disabled', async () => {
  const previous = process.env.AI_STANDARDIZATION_ENABLED;
  delete process.env.AI_STANDARDIZATION_ENABLED;
  let createCalls = 0;
  const service = new AiService({
    createJob: async () => { createCalls++; return { id: 1n }; },
  } as never);
  try {
    await assert.rejects(
      service.createJob({ model: 'configured-model' }),
      (error: { code?: string }) => error.code === 'AI_STANDARDIZATION_DISABLED',
    );
    assert.equal(createCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.AI_STANDARDIZATION_ENABLED;
    else process.env.AI_STANDARDIZATION_ENABLED = previous;
  }
});

test('manual AI job creation delegates when standardization is explicitly enabled', async () => {
  const previous = {
    enabled: process.env.AI_STANDARDIZATION_ENABLED,
    baseUrl: process.env.AI_BASE_URL,
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL,
  };
  process.env.AI_STANDARDIZATION_ENABLED = 'true';
  process.env.AI_BASE_URL = 'https://model.invalid/v1';
  process.env.AI_API_KEY = 'secret';
  process.env.AI_MODEL = 'model';
  let createCalls = 0;
  const service = new AiService({
    createJob: async () => { createCalls++; return { id: 1n }; },
  } as never);
  try {
    assert.deepEqual(await service.createJob({ model: 'configured-model' }), { id: 1n });
    assert.equal(createCalls, 1);
  } finally {
    for (const [name, value] of [
      ['AI_STANDARDIZATION_ENABLED', previous.enabled],
      ['AI_BASE_URL', previous.baseUrl],
      ['AI_API_KEY', previous.apiKey],
      ['AI_MODEL', previous.model],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('manual AI job creation rejects incomplete provider configuration', async () => {
  const previous = {
    enabled: process.env.AI_STANDARDIZATION_ENABLED,
    baseUrl: process.env.AI_BASE_URL,
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL,
  };
  process.env.AI_STANDARDIZATION_ENABLED = 'true';
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  let createCalls = 0;
  const service = new AiService({
    createJob: async () => { createCalls++; return { id: 1n }; },
  } as never);
  try {
    await assert.rejects(
      service.createJob({ model: 'configured-model' }),
      (error: { code?: string }) => error.code === 'AI_CONFIGURATION_INCOMPLETE',
    );
    assert.equal(createCalls, 0);
  } finally {
    for (const [name, value] of [
      ['AI_STANDARDIZATION_ENABLED', previous.enabled],
      ['AI_BASE_URL', previous.baseUrl],
      ['AI_API_KEY', previous.apiKey],
      ['AI_MODEL', previous.model],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
