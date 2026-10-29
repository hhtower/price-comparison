import http from 'k6/http';
import { check } from 'k6';

const baseUrl = (__ENV.BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/u, '');
const adminCookie = __ENV.ADMIN_COOKIE || '';

export const options = {
  scenarios: {
    catalog_cache_hit: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.CATALOG_HIT_RATE || 20),
      timeUnit: '1s',
      duration: __ENV.CATALOG_DURATION || '30s',
      preAllocatedVUs: 10,
      maxVUs: 100,
      tags: { scenario: 'catalog-cache-hit' },
      exec: 'catalogCacheHit',
    },
    catalog_cache_miss: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.CATALOG_MISS_RATE || 10),
      timeUnit: '1s',
      duration: __ENV.CATALOG_DURATION || '30s',
      preAllocatedVUs: 10,
      maxVUs: 100,
      startTime: '2s',
      tags: { scenario: 'catalog-cache-miss' },
      exec: 'catalogCacheMiss',
    },
    admin_list: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.ADMIN_RATE || 5),
      timeUnit: '1s',
      duration: __ENV.CATALOG_DURATION || '30s',
      preAllocatedVUs: 5,
      maxVUs: 50,
      startTime: '2s',
      tags: { scenario: 'admin-list' },
      exec: 'adminList',
    },
  },
  thresholds: {
    'http_req_duration{scenario:catalog-cache-hit}': ['p(95)<100'],
    'http_req_duration{scenario:catalog-cache-miss}': ['p(95)<300'],
    'http_req_duration{scenario:admin-list}': ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

function get(path, scenario) {
  const response = http.get(`${baseUrl}${path}`, {
    tags: { scenario },
    headers: adminCookie ? { Cookie: adminCookie } : undefined,
  });
  check(response, {
    [`${scenario} returns a success response`]: (value) => value.status >= 200 && value.status < 300,
  });
}

export function catalogCacheHit() {
  get('/v1/catalog?limit=20', 'catalog-cache-hit');
}

export function catalogCacheMiss() {
  get(`/v1/catalog?q=perf-${__VU}-${__ITER}&limit=20`, 'catalog-cache-miss');
}

export function adminList() {
  if (!adminCookie) throw new Error('ADMIN_COOKIE is required for admin performance scenario');
  get('/v1/admin/shops?limit=100', 'admin-list');
}
