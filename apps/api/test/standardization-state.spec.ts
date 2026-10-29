import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderRequestFailure as classify } from '../src/ai/standardization-state.js';

test('provider failure classification preserves policy verdicts ahead of HTTP retry hints', () => {
  assert.deepEqual(classify(Object.assign(new Error('response_format unavailable: request rejected by content policy'), { status: 503 })), { retryClass: 'provider_policy_rejection', retryable: false, requestOutcome: 'confirmed' });
  for (const status of [429, 502, 503]) assert.deepEqual(classify(Object.assign(new Error('temporarily unavailable'), { status })), { retryClass: 'provider_transient', retryable: true, requestOutcome: 'confirmed' });
  assert.deepEqual(classify(new Error('timeout after send')), { retryClass: 'provider_unknown', retryable: false, requestOutcome: 'unknown' });
  assert.deepEqual(classify(Object.assign(new Error('Bad request'), { status: 400 })), { retryClass: 'provider_terminal', retryable: false, requestOutcome: 'confirmed' });
});

test('structured confirmed invalid responses remain terminal ahead of HTTP retry hints', () => {
  for (const status of [undefined, 503]) {
    const error = Object.assign(new Error('AI response incomplete: length'), {
      retryClass: 'invalid_response', retryable: false, requestOutcome: 'confirmed', status,
    });
    assert.deepEqual(classify(error), { retryClass: 'invalid_response', retryable: false, requestOutcome: 'confirmed' });
  }
});

test('failure text or incomplete metadata cannot confirm an unknown request outcome', () => {
  for (const error of [
    new Error('AI response incomplete: length'),
    new Error('AI response JSON is invalid'),
    Object.assign(new Error('stream interrupted'), { retryClass: 'invalid_response', retryable: false, requestOutcome: 'unknown' }),
    Object.assign(new Error('stream interrupted'), { retryClass: 'invalid_response', retryable: false }),
    Object.assign(new Error('stream interrupted'), { retryClass: 'invalid_response', retryable: true, requestOutcome: 'confirmed' }),
    new Error('timed out after send'), new Error('caller cancelled'),
  ]) {
    assert.deepEqual(classify(error), { retryClass: 'provider_unknown', retryable: false, requestOutcome: 'unknown' });
  }
});
