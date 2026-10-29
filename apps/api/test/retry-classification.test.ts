import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRetryClass } from '../src/jobs/jobs.repository.js';

test('classifies provider transient failures as network retries', () => {
  const errors = [
    'Connection error.',
    '524 Cloudflare origin timeout',
    'Upstream HTTP/2 stream failed',
    'Upstream request failed',
    'stream_read_error',
    '429 rate limit exceeded',
    '500 internal server error',
    '502 bad gateway',
    '504 gateway timeout',
    'The service is temporarily unavailable. Please retry later.',
    '系统繁忙，请稍后再试',
    'AI response timed out after 180000ms',
  ];
  for (const error of errors) assert.equal(classifyRetryClass(error), 'network');
});

test('does not classify account and response correctness failures as network retries', () => {
  assert.equal(classifyRetryClass('403 Insufficient account balance'), 'business');
  assert.equal(classifyRetryClass('invalid JSON response'), 'invalid_response');
  assert.equal(classifyRetryClass('AI 审核身份与原始证据冲突: The identity conflicts with the explicit account brand'), 'business');
});
