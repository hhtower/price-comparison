import http from 'k6/http';
import { check } from 'k6';

const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/u, '');
const adminCookie = __ENV.ADMIN_COOKIE || '';
const model = __ENV.AI_MODEL || 'performance-fixture';

export const options = {
  scenarios: {
    ai_write: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.AI_RATE || 5),
      timeUnit: '1s',
      duration: __ENV.AI_DURATION || '30s',
      preAllocatedVUs: 10,
      maxVUs: 100,
      tags: { scenario: 'ai-write' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:ai-write}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  if (!adminCookie) throw new Error('ADMIN_COOKIE is required for AI performance scenario');
  const response = http.post(
    `${baseUrl}/v1/ai/jobs`,
    JSON.stringify({
      model,
      batchSize: Number(__ENV.AI_BATCH_SIZE || 30),
    }),
    {
      tags: { scenario: 'ai-write' },
      headers: {
        'Content-Type': 'application/json',
        ...(adminCookie ? { Cookie: adminCookie } : {}),
      },
    },
  );
  check(response, {
    'ai write endpoint accepts the request': (value) => value.status >= 200 && value.status < 300,
  });
}
