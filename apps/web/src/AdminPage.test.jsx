import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPage from './AdminPage.jsx';

function jsonResponse(value, status = 200) {
  return Response.json(value, { status });
}

function paged(items, total = items.length, page = 1, pageSize = 10) {
  return { items, total, page, pageSize };
}

describe('AdminPage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  test('待处理商品显示失败摘要，并为未记录的历史摘要提供说明', async () => {
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      return jsonResponse(paged(url.pathname === '/api/admin/products' ? [
        { id: '1', name: '失败商品', processingSummary: { reasonCode: 'request_outcome_unknown', processingDisposition: 'retry_available', reason: '模型请求超时（60 秒），结果未知' } },
        { id: '2', name: '历史商品' },
      ] : []));
    }));
    render(<AdminPage initialAuthenticated />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '待处理' }));
    const region = screen.getByRole('region', { name: '待处理商品' });
    expect(await within(region).findByText('模型请求超时（60 秒），结果未知')).toBeInTheDocument();
    expect(within(region).getByText('处理失败，可重试')).toBeInTheDocument();
    expect(within(region).getByText('暂无处理摘要')).toBeInTheDocument();
  });

  test.each([
    ['商品管理', '/api/admin/products', { latestPrice: '2.006', latestCurrency: 'CNY' }, 'CNY 2.01'],
    ['商品管理', '/api/admin/products', { latestPrice: '12.50', latestCurrency: 'CNY' }, 'CNY 12.5'],
    ['商品举报', '/api/admin/product-reports', { price: '0.333333333333', currency: 'USD', reason: 'price_mismatch' }, '测试商铺 · USD 0.33 · 价格或库存不符'],
    ['商品举报', '/api/admin/product-reports', { price: '350.00', currency: 'USD', reason: 'price_mismatch' }, '测试商铺 · USD 350 · 价格或库存不符'],
  ])('%s prices display at most two decimals without trailing zeros: %j', async (tab, endpoint, priceFields, expected) => {
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      return jsonResponse(paged(url.pathname === endpoint
        ? [{ id: '1', name: '测试商品', productName: '测试商品', shopName: '测试商铺', ...priceFields }] : []));
    }));
    render(<AdminPage initialAuthenticated />);
    await userEvent.setup().click(await screen.findByRole('button', { name: tab }));
    expect(await screen.findByText(expected, { exact: true })).toBeInTheDocument();
  });

  test('raw products show an explicit cannot-process result', async () => {
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/admin/products') return jsonResponse(paged([{ id: '1', name: '信息不足商品', standardizationOutcome: 'cannot_process' }]));
      return jsonResponse(paged([]));
    }));
    render(<AdminPage initialAuthenticated />);
    await userEvent.setup().click(await screen.findByRole('button', { name: '商品管理' }));
    expect(await screen.findByText('不能处理')).toBeInTheDocument();
  });

  test('opens standard products as a management tab instead of a modal', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/standard-products') return jsonResponse(paged([{ id: '11', name: '标准商品 A', platform: '平台 A', memberCount: '3', shopCount: '2' }]));
      if (url.pathname === '/api/admin/platforms') return jsonResponse(paged([]));
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));
    expect(await screen.findByLabelText('标准商品名称 标准商品 A')).toHaveValue('标准商品 A');
    expect(screen.queryByRole('heading', { name: '标准商品' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '标准商品管理' })).not.toBeInTheDocument();
  });

  test('selects the current standard product page and saves the name input', async () => {
    const user = userEvent.setup();
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      calls.push({ method: init?.method || 'GET', path: url.pathname, body: init?.body ? JSON.parse(init.body) : null });
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/platforms') return jsonResponse(paged([{ id: 'P1', name: '平台 A' }]));
      if (url.pathname === '/api/admin/standard-products' && (init?.method || 'GET') === 'PATCH') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/standard-products/11' && init?.method === 'PATCH') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/standard-products') return jsonResponse(paged([
        { id: '11', name: '标准商品 A', platform: '平台 A', memberCount: '3', shopCount: '2' },
        { id: '12', name: '标准商品 B', platform: '', memberCount: '1', shopCount: '1' },
      ]));
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));

    const selectAll = await screen.findByRole('checkbox', { name: '选择当前页标准商品' });
    await user.click(selectAll);
    expect(screen.getByRole('checkbox', { name: '选择 标准商品 A' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 标准商品 B' })).toBeChecked();
    expect(screen.getByRole('button', { name: '批量隐藏' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批量展示' })).toBeInTheDocument();

    const nameInput = screen.getByLabelText('标准商品名称 标准商品 A');
    await user.clear(nameInput);
    await user.type(nameInput, '标准商品 A（更新）');
    const aliasInput = screen.getByLabelText('搜索别名 标准商品 A');
    await user.type(aliasInput, '常用名称，Alternate Name');
    await user.click(screen.getAllByRole('button', { name: '保存' })[0]);
    await waitFor(() => expect(calls.find((call) => call.method === 'PATCH' && call.path === '/api/admin/standard-products/11')?.body).toEqual({ name: '标准商品 A（更新）', platform: '平台 A', aliases: ['常用名称', 'Alternate Name'] }));
  });

  test.each([
    ['OpenAI', ['Codex Sms Standard', 'Openai Sms Standard', 'ChatGPT Sms Standard']],
    ['Anthropic', ['Anthropic Sms Standard', 'Claude Sms Standard', 'Claude Code Sms Standard']],
    ['Google', ['Google Sms Standard', 'Gemini Sms Standard', 'Google AI Sms Standard']],
  ])('%s 标准商品跨搜索保留选择及合并目标，失败可重试', async (platform, names) => {
    const user = userEvent.setup();
    const products = names.map((name, index) => ({ id: String(index + 11), name, platform, memberCount: '1', shopCount: '1' }));
    const mergeBodies = [];
    let merged = false;
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops' || url.pathname === '/api/admin/platforms') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/standard-products/merge' && init?.method === 'POST') {
        mergeBodies.push(JSON.parse(init.body));
        if (mergeBodies.length === 1) return jsonResponse({ message: '合并暂时失败' }, 500);
        merged = true;
        return jsonResponse({ success: ['12', '13'], skipped: [], conflicts: [] });
      }
      if (url.pathname === '/api/admin/standard-products') {
        const keyword = url.searchParams.get('keyword')?.toLowerCase() || '';
        return jsonResponse(paged(products.filter(item => (!merged || item.id === '11') && item.name.toLowerCase().includes(keyword))));
      }
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));
    const search = screen.getByRole('textbox', { name: '搜索标准商品' });
    await user.type(search, names[0]);
    await user.click(await screen.findByRole('checkbox', { name: `选择 ${names[0]}` }));
    await user.clear(search);
    await user.type(search, names[1]);
    expect(screen.getByText('已选 1 个')).toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: `选择 ${names[1]}` }));
    await user.selectOptions(screen.getByRole('combobox', { name: '合并后保留' }), '11');
    await user.clear(search);
    await user.type(search, names[2]);
    await user.click(await screen.findByRole('checkbox', { name: `选择 ${names[2]}` }));
    expect(screen.getByText('已选 3 个')).toBeInTheDocument();
    const target = screen.getByRole('combobox', { name: '合并后保留' });
    expect(target).toHaveValue('11');
    expect(within(target).getAllByRole('option').map(option => option.textContent)).toEqual(['选择保留商品', ...names]);

    await user.clear(search);
    await user.type(search, '没有匹配的商品');
    expect(await screen.findByText('暂无标准商品')).toBeInTheDocument();
    expect(screen.getByText('已选 3 个')).toBeInTheDocument();
    expect(target).toHaveValue('11');
    await user.clear(search);
    for (const name of names) expect(await screen.findByRole('checkbox', { name: `选择 ${name}` })).toBeChecked();

    await user.click(screen.getByRole('button', { name: '合并', exact: true }));
    expect(await screen.findByText('合并暂时失败')).toBeInTheDocument();
    expect(screen.getByText('已选 3 个')).toBeInTheDocument();
    expect(target).toHaveValue('11');
    await user.click(screen.getByRole('button', { name: '合并', exact: true }));
    expect(await screen.findByText('合并完成：成功 2，冲突 0')).toBeInTheDocument();
    expect(mergeBodies).toEqual([
      { targetId: '11', sourceIds: ['12', '13'], confirmEvidenceConflict: false },
      { targetId: '11', sourceIds: ['12', '13'], confirmEvidenceConflict: false },
    ]);
    expect(screen.queryByText('已选 3 个')).not.toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: `选择 ${names[0]}` })).not.toBeChecked();
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: `选择 ${names[1]}` })).not.toBeInTheDocument());
  });

  test.each(['单项', '当前页'])('取消%s选择时清除失效合并目标，保留其他页选择', async mode => {
    const user = userEvent.setup();
    const products = [
      { id: '11', name: 'Codex Sms Standard', platform: 'OpenAI' },
      { id: '12', name: 'Openai Sms Standard', platform: 'OpenAI' },
      { id: '13', name: 'ChatGPT Sms Standard', platform: 'OpenAI' },
    ];
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops' || url.pathname === '/api/admin/platforms') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/standard-products') {
        const page = Number(url.searchParams.get('page') || 1);
        return jsonResponse(paged(page === 1 ? products.slice(0, 2) : products.slice(2), 11, page));
      }
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择当前页标准商品' }));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 ChatGPT Sms Standard' }));
    expect(screen.getByText('已选 3 个')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: '合并后保留' }), '13');
    await user.click(screen.getByRole('checkbox', { name: mode === '单项' ? '选择 ChatGPT Sms Standard' : '选择当前页标准商品' }));
    expect(screen.getByText('已选 2 个')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '合并后保留' })).toHaveValue('');
    expect(screen.getByRole('button', { name: '合并', exact: true })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '上一页' }));
    expect(await screen.findByRole('checkbox', { name: '选择 Codex Sms Standard' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 Openai Sms Standard' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择当前页标准商品' })).toBeChecked();
    await user.selectOptions(screen.getByRole('combobox', { name: '合并后保留' }), '11');
    expect(screen.getByRole('button', { name: '合并', exact: true })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '清除选择' }));
    expect(screen.getByRole('checkbox', { name: '选择 Codex Sms Standard' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '选择 Openai Sms Standard' })).not.toBeChecked();
    expect(screen.queryByRole('combobox', { name: '合并后保留' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '选择当前页标准商品' }));
    expect(screen.getByRole('combobox', { name: '合并后保留' })).toHaveValue('');
    expect(screen.getByRole('button', { name: '合并', exact: true })).toBeDisabled();
  });

  test('edits canonical family, product and tier as separate fields', async () => {
    const user = userEvent.setup();
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      calls.push({ method: init?.method || 'GET', path: url.pathname, body: init?.body ? JSON.parse(init.body) : null });
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/platforms') return jsonResponse(paged([{ id: 'P1', name: 'openai' }]));
      if (url.pathname === '/api/admin/standard-products' && (init?.method || 'GET') === 'PATCH') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/standard-products/11' && init?.method === 'PATCH') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/standard-products') return jsonResponse(paged([{ id: '11', name: 'openai / chatgpt / free', platform: 'openai', canonicalFamily: 'openai', canonicalProduct: 'chatgpt', canonicalTier: 'free', memberCount: '3', shopCount: '2' }]));
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));
    const family = await screen.findByLabelText('标准商品 family openai / chatgpt / free');
    const product = screen.getByLabelText('标准商品 product openai / chatgpt / free');
    const tier = screen.getByLabelText('标准商品 tier openai / chatgpt / free');
    await user.clear(tier);
    await user.type(tier, 'plus');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(calls.find((call) => call.method === 'PATCH' && call.path === '/api/admin/standard-products/11')?.body).toEqual({ platform: 'openai', canonicalFamily: 'openai', canonicalProduct: 'chatgpt', canonicalTier: 'plus' }));
    expect(family).toHaveValue('openai');
    expect(product).toHaveValue('chatgpt');
  });

  test.each(['family', 'product', 'tier'])('refreshes the saved canonical %s and shows progress while saving', async (field) => {
    const user = userEvent.setup();
    let saved = false;
    let resolveSave;
    const pending = new Promise(resolve => { resolveSave = resolve; });
    const initial = { id: '11', name: 'vendor / service / standard', platform: '', canonicalFamily: 'vendor', canonicalProduct: 'service', canonicalTier: 'standard' };
    const canonicalField = { family: 'canonicalFamily', product: 'canonicalProduct', tier: 'canonicalTier' }[field];
    const updated = { ...initial, [canonicalField]: 'updated', name: 'saved identity' };
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/standard-products/11' && init?.method === 'PATCH') {
        requests.push(JSON.parse(init.body));
        await pending;
        saved = true;
        return jsonResponse(updated);
      }
      if (url.pathname === '/api/admin/standard-products') return jsonResponse(paged([saved ? updated : initial]));
      if (url.pathname === '/api/admin/shops' || url.pathname === '/api/admin/platforms') return jsonResponse(paged([]));
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));
    const input = await screen.findByLabelText(`标准商品 ${field} ${initial.name}`);
    await user.clear(input);
    await user.type(input, 'UPDATED');
    await user.click(screen.getByRole('button', { name: '保存', exact: true }));
    try {
      expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled();
      expect(input).toBeDisabled();
      expect(requests).toEqual([{ platform: '', canonicalFamily: 'vendor', canonicalProduct: 'service', canonicalTier: 'standard', [canonicalField]: 'UPDATED' }]);
    } finally { resolveSave(); }
    expect(await screen.findByText('标准商品已保存')).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText(`标准商品 ${field} ${updated.name}`)).toHaveValue('updated'));
    expect(screen.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  });

  test('shows identity save errors and retains the draft for a corrected retry', async () => {
    const user = userEvent.setup();
    const initial = { id: '11', name: 'openai / chatgpt / free', platform: '', canonicalFamily: 'openai', canonicalProduct: 'chatgpt', canonicalTier: 'free' };
    let saved = false;
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/standard-products/11' && init?.method === 'PATCH') {
        if (JSON.parse(init.body).canonicalTier === 'plus') return jsonResponse({ error: { code: 'STANDARD_PRODUCT_KEY_CONFLICT', message: '相同 family、product、tier 的标准商品已经存在' } }, 400);
        saved = true;
        return jsonResponse({ ...initial, canonicalTier: 'go' });
      }
      if (url.pathname === '/api/admin/standard-products') return jsonResponse(paged([{ ...initial, canonicalTier: saved ? 'go' : 'free' }]));
      if (url.pathname === '/api/admin/shops' || url.pathname === '/api/admin/platforms') return jsonResponse(paged([]));
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));
    const tier = await screen.findByLabelText(`标准商品 tier ${initial.name}`);
    await user.clear(tier);
    await user.type(tier, 'plus');
    await user.click(screen.getByRole('button', { name: '保存', exact: true }));
    expect(await screen.findByText('相同 family、product、tier 的标准商品已经存在')).toBeVisible();
    expect(tier).toHaveValue('plus');
    expect(screen.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await user.clear(tier);
    await user.type(tier, 'go');
    await user.click(screen.getByRole('button', { name: '保存', exact: true }));
    expect(await screen.findByText('标准商品已保存')).toBeVisible();
    expect(screen.queryByText('相同 family、product、tier 的标准商品已经存在')).not.toBeInTheDocument();
  });

  test.each([null, '已有标准商品'])('creates a standard product with selected products whose current standard is %s', async (standardProductName) => {
    const user = userEvent.setup();
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      calls.push({ method: init?.method || 'GET', path: url.pathname + url.search, body: init?.body ? JSON.parse(init.body) : null });
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/platforms') return jsonResponse(paged([{ id: 'P1', name: '平台 A' }, { id: 'P2', name: '平台 B' }]));
      if (url.pathname === '/api/admin/standard-products' && init?.method === 'POST') return jsonResponse({ id: '20' }, 201);
      if (url.pathname === '/api/admin/standard-products') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/products') {
        const items = standardProductName && url.searchParams.get('pending') === 'true'
          ? [] : [{ id: '3', name: '待绑定商品', shopName: '测试店', standardProductName }];
        return jsonResponse(paged(items));
      }
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));
    await user.click(await screen.findByRole('button', { name: '新增标准商品' }));
    const dialog = await screen.findByRole('dialog', { name: '新增标准商品' });
    expect(within(dialog).getByLabelText('family')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('product')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('tier')).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText('搜索商品')).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: '平台' })).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText('搜索平台')).toBe(within(dialog).getByRole('combobox', { name: '平台' }));
    await user.type(within(dialog).getByRole('combobox', { name: '平台' }), '平台 B');
    expect(within(dialog).getByRole('option', { name: '平台 B' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('option', { name: '平台 A' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('option', { name: '平台 B' }));
    expect(within(dialog).getByRole('combobox', { name: '平台' })).toHaveValue('平台 B');
    await user.clear(within(dialog).getByRole('combobox', { name: '平台' }));
    expect(within(dialog).getByRole('button', { name: '创建并绑定' })).toBeEnabled();
    await user.click(await within(dialog).findByRole('button', { name: /待绑定商品.*选择/ }));
    expect(within(dialog).getByText('已选 1 个')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '待绑定商品 ×' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '待绑定商品 ×' }));
    expect(within(dialog).getByText('选择')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '创建并绑定' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: /待绑定商品.*选择/ }));
    await user.type(within(dialog).getByLabelText('family'), 'openai');
    await user.type(within(dialog).getByLabelText('product'), 'chatgpt');
    await user.type(within(dialog).getByLabelText('tier'), 'plus');
    expect(within(dialog).getByRole('button', { name: '创建并绑定' })).toBeEnabled();
    await user.click(within(dialog).getByRole('combobox', { name: '平台' }));
    await user.clear(within(dialog).getByRole('combobox', { name: '平台' }));
    await user.type(within(dialog).getByRole('combobox', { name: '平台' }), '平台 A');
    await user.click(within(dialog).getByRole('option', { name: '平台 A' }));
    await user.click(within(dialog).getByRole('button', { name: '创建并绑定' }));
    await waitFor(() => expect(calls.find(call => call.method === 'POST' && call.path === '/api/admin/standard-products')?.body).toEqual({ family: 'openai', product: 'chatgpt', tier: 'plus', platform: '平台 A', productIds: ['3'], confirmEvidenceConflict: false }));
    expect(screen.queryByRole('dialog', { name: '新增标准商品' })).not.toBeInTheDocument();
  });

  test.each([
    ['identity', 'family、product、tier 必须填写'],
    ['platform', '请从下拉列表选择平台'],
    ['products', '请先选择商品'],
  ])('shows a visible reason inside the create dialog when %s is missing', async (missing, message) => {
    const user = userEvent.setup();
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      if (init?.method === 'POST') posts.push(input);
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/platforms') return jsonResponse(paged([{ id: 'P1', name: '平台 A' }]));
      if (url.pathname === '/api/admin/products') return jsonResponse(paged([{ id: '3', name: '待绑定商品', shopName: '测试店' }]));
      return jsonResponse(paged([]));
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));
    await user.click(await screen.findByRole('button', { name: '新增标准商品' }));
    const dialog = await screen.findByRole('dialog', { name: '新增标准商品' });
    if (missing !== 'identity') {
      await user.type(within(dialog).getByLabelText('family'), 'openai');
      await user.type(within(dialog).getByLabelText('product'), 'chatgpt');
      await user.type(within(dialog).getByLabelText('tier'), 'plus');
    }
    await user.type(within(dialog).getByRole('combobox', { name: '平台' }), '平台 A');
    if (missing !== 'platform') await user.click(await within(dialog).findByRole('option', { name: '平台 A' }));
    if (missing !== 'products') await user.click(await within(dialog).findByRole('button', { name: /待绑定商品.*选择/ }));
    await user.click(within(dialog).getByRole('button', { name: '创建并绑定' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(posts).toHaveLength(0);
  });

  test('keeps creation errors in the dialog and retries without losing selections or submitting twice', async () => {
    const user = userEvent.setup();
    const bodies = [];
    let finishCreation;
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/platforms') return jsonResponse(paged([{ id: 'P1', name: '平台 A' }]));
      if (url.pathname === '/api/admin/products') return jsonResponse(paged([{ id: '3', name: '待绑定商品', shopName: '测试店' }]));
      if (url.pathname === '/api/admin/standard-products' && init?.method === 'POST') {
        bodies.push(JSON.parse(init.body));
        if (bodies.length === 1) return jsonResponse({ error: { code: 'STANDARD_PRODUCT_KEY_CONFLICT', message: '标准商品身份已存在' } }, 400);
        return new Promise(resolve => { finishCreation = () => resolve(jsonResponse({ id: '20' }, 201)); });
      }
      return jsonResponse(paged([]));
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));
    await user.click(await screen.findByRole('button', { name: '新增标准商品' }));
    const dialog = await screen.findByRole('dialog', { name: '新增标准商品' });
    await user.type(within(dialog).getByLabelText('family'), 'openai');
    await user.type(within(dialog).getByLabelText('product'), 'chatgpt');
    await user.type(within(dialog).getByLabelText('tier'), 'plus');
    await user.click(within(dialog).getByRole('combobox', { name: '平台' }));
    await user.click(await within(dialog).findByRole('option', { name: '平台 A' }));
    await user.click(await within(dialog).findByRole('button', { name: /待绑定商品.*选择/ }));
    await user.click(within(dialog).getByRole('button', { name: '创建并绑定' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('标准商品身份已存在');
    expect(within(dialog).getByLabelText('tier')).toHaveValue('plus');
    expect(within(dialog).getByText('已选 1 个')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('tier'));
    await user.type(within(dialog).getByLabelText('tier'), 'pro');
    await user.dblClick(within(dialog).getByRole('button', { name: '创建并绑定' }));
    expect(await within(dialog).findByRole('button', { name: '创建中…' })).toBeDisabled();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ family: 'openai', product: 'chatgpt', tier: 'pro', platform: '平台 A', productIds: ['3'], confirmEvidenceConflict: false });
    finishCreation();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新增标准商品' })).not.toBeInTheDocument());
    expect(await screen.findByText('标准商品已创建')).toBeInTheDocument();
  });

  test('does not render the shared identity update note', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/platforms') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/standard-products') return jsonResponse(paged([]));
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标准商品' }));
    expect(screen.queryByText('修改 family 或 product 会同步更新所有相同值的标准商品；tier 只影响当前商品。')).not.toBeInTheDocument();
  });

  test('opens platform management as a management tab instead of a modal', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/platforms') return jsonResponse(paged([{ id: 'P1', name: '平台 A', standardProductCount: '2' }]));
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '商品平台' }));
    expect(await screen.findByDisplayValue('平台 A')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '商品平台' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '商品平台管理' })).not.toBeInTheDocument();
  });

  test('抓取记录归入商品管理任务台，按指定顺序切换并支持翻页', async () => {
    const user = userEvent.setup();
    const runRequests = [];
    vi.stubGlobal('EventSource', undefined);
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/ai/status') return jsonResponse({ configured: true, job: null });
      if (url.pathname === '/api/admin/ai/task-queue' || url.pathname === '/api/admin/ai/retry-pool') return jsonResponse({ items: [], total: 0 });
      if (url.pathname === '/api/admin/tasks/crawler/status') return jsonResponse({ workerCount: 1, counters: {}, instances: {} });
      if (url.pathname === '/api/admin/run-history') {
        const page = Number(url.searchParams.get('page'));
        runRequests.push(page);
        return jsonResponse({
          items: [{ id: page > 1 ? '11' : '1', shopId: page > 1 ? '202' : '101', shopName: page > 1 ? '青禾商铺' : '星河商铺', startedAt: '2026-09-27T08:00:00Z', finishedAt: '2026-09-27T08:01:00Z', status: 'succeeded', itemCount: '12', error: null }],
          total: 11, page, pageSize: 10,
        });
      }
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(screen.getByRole('button', { name: '任务台' }));
    expect(screen.queryByRole('button', { name: '抓取记录' })).not.toBeInTheDocument();
    const workbench = screen.getByRole('region', { name: '后台任务' });
    expect(within(workbench).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['抓取', '抓取记录', '标准化', '标准化记录', '标签抽取', '标签抽取记录']);
    expect(within(workbench).getByRole('tab', { name: '抓取' })).toHaveAttribute('aria-selected', 'true');
    expect(within(workbench).getByRole('region', { name: '抓取任务' })).toBeInTheDocument();
    expect(runRequests).toEqual([]);
    await user.click(within(workbench).getByRole('tab', { name: '抓取记录' }));
    const records = within(workbench).getByRole('region', { name: '抓取记录' });
    expect(await within(records).findByText('星河商铺')).toBeInTheDocument();
    expect(within(records).queryByText('商铺 #101')).not.toBeInTheDocument();
    expect(records).toHaveTextContent('已完成 · 12 件商品');
    await user.click(within(records).getByRole('button', { name: '下一页' }));
    expect(await within(records).findByText('青禾商铺')).toBeInTheDocument();
    expect(within(records).queryByText('星河商铺')).not.toBeInTheDocument();
    expect(within(records).getByRole('button', { name: '下一页' })).toBeDisabled();
    await user.click(within(records).getByRole('button', { name: '上一页' }));
    expect(await within(records).findByText('星河商铺')).toBeInTheDocument();
    expect(within(records).getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(runRequests).toEqual([1, 2, 1]);
    await user.click(within(workbench).getByRole('tab', { name: '抓取' }));
    expect(within(workbench).getByRole('region', { name: '抓取任务' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '抓取记录' })).not.toBeInTheDocument();
    await user.click(within(workbench).getByRole('tab', { name: '标准化' }));
    expect(within(workbench).getByRole('region', { name: '标准化队列' })).toBeInTheDocument();
    await user.click(within(workbench).getByRole('tab', { name: '标准化记录' }));
    expect(await within(workbench).findByText('暂无符合条件的任务。')).toBeInTheDocument();
  });

  test('task desk does not expose a second global product management view', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/ai/status') return jsonResponse({ configured: false, job: null });
      if (url.pathname === '/api/admin/ai/jobs') return jsonResponse(paged([]));
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '任务台' }));
    expect(await screen.findByRole('tab', { name: '标准化' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '标准商品与抽查' })).not.toBeInTheDocument();
    expect(screen.queryByText('全局待处理商品')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '后台任务' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'AI 商品标准化任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开任务台' })).not.toBeInTheDocument();
  });

  test('原始商品名称链接在新标签页打开来源商品，缺失或非网页地址保持文字', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/products') return jsonResponse(paged([
        { id: '1', name: '商品甲', url: 'https://shop.example/products/1?sku=2', shopName: '商铺甲' },
        { id: '2', name: '商品乙', url: 'http://shop.example/products/2', shopName: '商铺乙' },
        { id: '3', name: '无链接商品', url: '' },
        { id: '4', name: '异常链接商品', url: 'javascript:alert(1)' },
      ]));
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    const products = screen.getByRole('region', { name: '原始商品' });
    const first = await within(products).findByRole('link', { name: '商品甲' });
    expect(first).toHaveAttribute('href', 'https://shop.example/products/1?sku=2');
    expect(first).toHaveAttribute('target', '_blank');
    expect(first).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(products).getByRole('link', { name: '商品乙' })).toHaveAttribute('href', 'http://shop.example/products/2');
    for (const name of ['无链接商品', '异常链接商品']) {
      expect(within(products).getByText(name)).toBeInTheDocument();
      expect(within(products).queryByRole('link', { name })).not.toBeInTheDocument();
    }
  });

  test('原始商品支持按商铺筛选', async () => {
    const user = userEvent.setup();
    const requests = [];
    const shopRequests = [];
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') {
        shopRequests.push(url.search);
        return jsonResponse(paged([
          { id: 1, name: '商铺甲', enabled: true },
          { id: 2, name: '商铺乙', enabled: true },
        ]));
      }
      if (url.pathname === '/api/admin/products') {
        requests.push(url.search);
        return jsonResponse(paged(url.searchParams.get('shopId') === '2'
          ? [{ id: 2, name: '乙商品', shop_name: '商铺乙' }]
          : [{ id: 1, name: '甲商品', shop_name: '商铺甲' }]));
      }
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    expect(await screen.findByText('甲商品')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /甲商品/ })).getByText('商铺甲')).toBeInTheDocument();
    const shopFilter = screen.getByRole('combobox', { name: '原始商品商铺' });
    expect(shopFilter).toHaveValue('');
    await user.type(shopFilter, '商铺乙');
    expect(await screen.findByText('乙商品')).toBeInTheDocument();
    expect(shopRequests.some(search => new URLSearchParams(search).get('keyword') === '商铺乙')).toBe(true);
    await waitFor(() => expect(requests.some(search => new URLSearchParams(search).get('shopId') === '2')).toBe(true));
  });

  test('原始商品支持单个和批量绑定标准商品', async () => {
    const user = userEvent.setup();
    const bindings = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/products') return jsonResponse(paged([
        { id: '3', name: '商品甲', shop_name: '商铺甲' },
        { id: '4', name: '商品乙', shop_name: '商铺乙' },
      ]));
      if (url.pathname === '/api/admin/standard-products') return jsonResponse(paged([{ id: '11', name: '标准商品甲', platform: '平台甲' }]));
      if (url.pathname === '/api/admin/products/standard-products/bind' && init.method === 'POST') {
        bindings.push(JSON.parse(init.body));
        return jsonResponse({ success: JSON.parse(init.body).productIds, skipped: [], conflicts: [] }, 201);
      }
      return jsonResponse({ error: `Unhandled ${url.pathname}` }, 404);
    }));

    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));

    await user.click(within(screen.getByRole('row', { name: /商品甲/ })).getByRole('button', { name: '选择标准商品' }));
    const singlePicker = await screen.findByRole('dialog', { name: '选择标准商品' });
    await user.click(within(singlePicker).getByRole('button', { name: /标准商品甲/ }));
    await waitFor(() => expect(bindings).toContainEqual({ productIds: ['3'], standardProductId: '11', confirmOwnershipChange: false }));

    await user.click(screen.getByRole('checkbox', { name: '选择 商品甲' }));
    await user.click(screen.getByRole('checkbox', { name: '选择 商品乙' }));
    await user.click(screen.getByRole('button', { name: '绑定标准商品' }));
    const batchPicker = await screen.findByRole('dialog', { name: '选择标准商品' });
    await user.click(within(batchPicker).getByRole('button', { name: /标准商品甲/ }));
    await waitFor(() => expect(bindings).toContainEqual({ productIds: ['3', '4'], standardProductId: '11', confirmOwnershipChange: false }));
  });

  test('切换到待处理时清除原始商品选择，批量删除只提交当前页签选择', async () => {
    const user = userEvent.setup();
    const deletions = [];
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/products') return jsonResponse(paged(url.searchParams.get('pending') === 'true'
        ? deletions.length ? [] : [{ id: '2', name: '待处理商品乙', evidenceConflict: 'warranty conflict (::general): name declares 43200 minutes, but sourceData.evidence declares 4320 minutes；「30天质保」 vs 「✓ 3天质保」' }]
        : [{ id: '1', name: '已归类商品甲' }]));
      if (url.pathname === '/api/admin/products/batch-delete' && init.method === 'POST') {
        const { productIds } = JSON.parse(init.body);
        deletions.push(productIds);
        return jsonResponse({ success: productIds, failures: [] });
      }
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 已归类商品甲' }));
    await user.click(screen.getByRole('button', { name: '待处理' }));
    await screen.findByRole('checkbox', { name: '选择 待处理商品乙' });
    expect(screen.getByRole('note')).toHaveTextContent('质保时长矛盾：标题「30天质保」 ↔ 描述「✓ 3天质保」');
    expect(screen.queryByRole('button', { name: '批量删除' })).not.toBeInTheDocument();
    expect(screen.queryByText('已选 1 件')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '选择 待处理商品乙' }));
    await user.click(screen.getByRole('button', { name: '批量删除' }));
    expect(await screen.findByText(/成功 1 件，失败 0 件/)).toBeInTheDocument();
    expect(deletions).toEqual([['2']]);
  });

  describe.each(['原始商品', '待处理'])('%s批量删除', (managementTab) => {
    const regionName = managementTab === '待处理' ? '待处理商品' : '原始商品';
    const emptyText = managementTab === '待处理' ? '暂无待处理商品' : '暂无商品';
    function installProducts(items, onDelete = async () => {}) {
      const deletions = [];
      const deleted = new Set();
      vi.stubGlobal('confirm', vi.fn(() => true));
      vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
        const url = new URL(input, 'http://localhost');
        if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
        if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
        if (url.pathname === '/api/admin/products') {
          const page = Number(url.searchParams.get('page') || 1);
          const recycled = url.searchParams.get('deleted') === 'true';
          const visible = items.filter(item => deleted.has(item.id) === recycled);
          return jsonResponse(paged(visible.slice((page - 1) * 10, page * 10).map(item => ({ ...item, deletedAt: recycled ? '2026-09-25T00:00:00Z' : null })), visible.length, page));
        }
        if (init.method === 'POST' && url.pathname === '/api/admin/products/batch-delete') {
          const success = [];
          const failures = [];
          for (const id of JSON.parse(init.body).productIds) {
            deletions.push(id);
            try {
              await onDelete(id);
              deleted.add(id);
              success.push(id);
            } catch (error) { failures.push({ id, reason: error.message }); }
          }
          return jsonResponse({ success, failures });
        }
        if (init.method === 'DELETE' && /^\/api\/admin\/products\/\d+$/.test(url.pathname)) {
          const id = url.pathname.split('/').at(-1);
          deletions.push(id);
          try {
            await onDelete(id);
            deleted.add(id);
            return new Response(null, { status: 204 });
          } catch (error) { return jsonResponse({ error: error.message }, 500); }
        }
        return jsonResponse({ error: `Unhandled ${url.pathname}` }, 404);
      }));
      return deletions;
    }

    test('53 件跨页商品通过一次批量请求删除，不消耗逐件删除的限流额度', async () => {
      const user = userEvent.setup();
      installProducts(Array.from({ length: 53 }, (_, index) => ({ id: String(index + 1), name: `商品${index + 1}` })));
      const handleFetch = fetch.getMockImplementation();
      fetch.mockImplementation((input, init = {}) => init.method === 'DELETE'
        ? Promise.resolve(jsonResponse({ error: '请求过于频繁，请稍后重试' }, 429))
        : handleFetch(input, init));
      render(<AdminPage initialAuthenticated />);
      await user.click(await screen.findByRole('button', { name: '商品管理' }));
      await user.click(screen.getByRole('button', { name: managementTab }));
      for (let page = 1; page <= 6; page += 1) {
        await screen.findByRole('checkbox', { name: `选择 商品${(page - 1) * 10 + 1}` });
        await user.click(screen.getByRole('checkbox', { name: '选择本页商品' }));
        if (page < 6) await user.click(screen.getByRole('button', { name: '下一页' }));
      }
      await user.click(screen.getByRole('button', { name: '批量删除' }));
      expect(await screen.findByText(/成功 53 件，失败 0 件/)).toBeInTheDocument();
      const mutations = fetch.mock.calls.filter(([, init]) => ['POST', 'DELETE'].includes(init?.method));
      expect(mutations).toHaveLength(1);
      expect(mutations[0][0]).toBe('/api/admin/products/batch-delete');
      expect(JSON.parse(mutations[0][1].body).productIds).toHaveLength(53);
      expect(await within(screen.getByRole('region', { name: regionName })).findByText(emptyText)).toBeInTheDocument();
    });

    test('批量请求被限流时保留全部选择并允许重试', async () => {
      const user = userEvent.setup();
      installProducts([{ id: '1', name: '商品甲' }, { id: '2', name: '商品乙' }]);
      const handleFetch = fetch.getMockImplementation();
      fetch.mockImplementation((input, init = {}) => input === '/api/admin/products/batch-delete'
        ? Promise.resolve(jsonResponse({ error: '请求过于频繁，请稍后重试' }, 429))
        : handleFetch(input, init));
      render(<AdminPage initialAuthenticated />);
      await user.click(await screen.findByRole('button', { name: '商品管理' }));
      await user.click(screen.getByRole('button', { name: managementTab }));
      await user.click(await screen.findByRole('checkbox', { name: '选择本页商品' }));
      await user.click(screen.getByRole('button', { name: '批量删除' }));
      expect(await screen.findByText(/成功 0 件，失败 2 件.*请求过于频繁/)).toBeInTheDocument();
      expect(screen.getByText('已选 2 件')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '批量删除' })).toBeEnabled();
      fetch.mockImplementation(handleFetch);
      await user.click(screen.getByRole('button', { name: '批量删除' }));
      expect(await screen.findByText(/成功 2 件，失败 0 件/)).toBeInTheDocument();
    });

    test('仅删除跨页选中的商品，刷新空页并可在回收站查看', async () => {
      const user = userEvent.setup();
      const deletions = installProducts(Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), name: `商品${index + 1}` })));
      render(<AdminPage initialAuthenticated />);
      await user.click(await screen.findByRole('button', { name: '商品管理' }));
      await user.click(screen.getByRole('button', { name: managementTab }));
      await screen.findByRole('checkbox', { name: '选择 商品1' });
      expect(screen.queryByRole('button', { name: '批量删除' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: '选择本页商品' }));
      await user.click(screen.getByRole('checkbox', { name: '选择 商品2' }));
      await user.click(screen.getByRole('button', { name: '下一页' }));
      await screen.findByRole('checkbox', { name: '选择 商品11' });
      await user.click(screen.getByRole('checkbox', { name: '选择本页商品' }));
      await user.click(screen.getByRole('button', { name: '批量删除' }));
      expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/11.*回收站/));
      expect(await screen.findByText(/成功 11 件，失败 0 件/)).toBeInTheDocument();
      expect(deletions).toEqual(['1', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
      expect(await screen.findByRole('checkbox', { name: '选择 商品2' })).not.toBeChecked();
      expect(screen.getByText('第 1 / 1 页，共 1 条')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '批量删除' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: '回收站' }));
      expect(await screen.findByText('商品1')).toBeInTheDocument();
      expect(screen.queryByText('商品2')).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: '恢复商品' })).toHaveLength(10);
      if (managementTab === '待处理') await user.click(screen.getByRole('checkbox', { name: '选择本页商品' }));
      expect(screen.queryByRole('button', { name: '批量删除' })).not.toBeInTheDocument();
    });

    test('取消确认时不删除且保留选择', async () => {
      const user = userEvent.setup();
      const deletions = installProducts([{ id: '1', name: '商品甲' }]);
      window.confirm.mockReturnValue(false);
      render(<AdminPage initialAuthenticated />);
      await user.click(await screen.findByRole('button', { name: '商品管理' }));
      await user.click(screen.getByRole('button', { name: managementTab }));
      await user.click(await screen.findByRole('checkbox', { name: '选择 商品甲' }));
      await user.click(screen.getByRole('button', { name: '批量删除' }));
      expect(window.confirm).toHaveBeenCalledOnce();
      expect(deletions).toEqual([]);
      expect(screen.getByRole('checkbox', { name: '选择 商品甲' })).toBeChecked();
      expect(screen.getByRole('button', { name: '批量删除' })).toBeEnabled();
    });

    test.each([['部分失败', ['2'], 1], ['全部失败', ['1', '2'], 0]])('%s时保留失败项，重试不重复删除成功项', async (_, failedIds, succeeded) => {
      const user = userEvent.setup();
      const failures = new Set(failedIds);
      const deletions = installProducts([{ id: '1', name: '商品甲' }, { id: '2', name: '商品乙' }], async id => {
        if (failures.has(id)) throw new Error('服务暂不可用');
      });
      render(<AdminPage initialAuthenticated />);
      await user.click(await screen.findByRole('button', { name: '商品管理' }));
      await user.click(screen.getByRole('button', { name: managementTab }));
      await user.click(await screen.findByRole('checkbox', { name: '选择本页商品' }));
      await user.click(screen.getByRole('button', { name: '批量删除' }));
      expect(await screen.findByText(new RegExp(`成功 ${succeeded} 件，失败 ${failedIds.length} 件.*服务暂不可用`))).toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByRole('button', { name: '删除商品' })).toHaveLength(failedIds.length));
      expect(screen.getByRole('checkbox', { name: '选择 商品乙' })).toBeChecked();
      expect(screen.getByText(`已选 ${failedIds.length} 件`)).toBeInTheDocument();
      failures.clear();
      await user.click(screen.getByRole('button', { name: '批量删除' }));
      expect(await screen.findByText(new RegExp(`成功 ${failedIds.length} 件，失败 0 件`))).toBeInTheDocument();
      expect(deletions).toEqual(['1', '2', ...failedIds]);
      expect(await within(screen.getByRole('region', { name: regionName })).findByText(emptyText)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '批量删除' })).not.toBeInTheDocument();
    });

    test('删除进行中禁止重复提交和修改选择', async () => {
      const user = userEvent.setup();
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      const deletions = installProducts([{ id: '1', name: '商品甲' }], () => pending);
      render(<AdminPage initialAuthenticated />);
      await user.click(await screen.findByRole('button', { name: '商品管理' }));
      await user.click(screen.getByRole('button', { name: managementTab }));
      await user.click(await screen.findByRole('checkbox', { name: '选择 商品甲' }));
      await user.click(screen.getByRole('button', { name: '批量删除' }));
      const deleting = screen.getByRole('button', { name: '删除中…' });
      expect(deleting).toBeDisabled();
      expect(screen.getByRole('button', { name: '绑定标准商品' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '清除选择' })).toBeDisabled();
      if (managementTab === '待处理') {
        expect(screen.getByRole('button', { name: '绑定标签' })).toBeDisabled();
        expect(screen.getByRole('button', { name: '新增标准商品' })).toBeDisabled();
      }
      expect(screen.getByRole('checkbox', { name: '选择 商品甲' })).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: '选择本页商品' })).toBeDisabled();
      await user.click(deleting);
      expect(deletions).toEqual(['1']);
      finish();
      expect(await screen.findByText(/成功 1 件，失败 0 件/)).toBeInTheDocument();
      expect(await within(screen.getByRole('region', { name: regionName })).findByText(emptyText)).toBeInTheDocument();
    });

    test('单个删除已选商品后不会残留批量删除目标', async () => {
      const user = userEvent.setup();
      const deletions = installProducts([{ id: '1', name: '商品甲' }, { id: '2', name: '商品乙' }]);
      render(<AdminPage initialAuthenticated />);
      await user.click(await screen.findByRole('button', { name: '商品管理' }));
      await user.click(screen.getByRole('button', { name: managementTab }));
      await user.click(await screen.findByRole('checkbox', { name: '选择 商品甲' }));
      await user.click(within(screen.getByRole('row', { name: /商品甲/ })).getByRole('button', { name: '删除商品' }));
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 商品甲' })).not.toBeInTheDocument());
      expect(screen.queryByText('已选 1 件')).not.toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: '选择 商品乙' }));
      await user.click(screen.getByRole('button', { name: '批量删除' }));
      expect(await screen.findByText(/成功 1 件，失败 0 件/)).toBeInTheDocument();
      expect(deletions).toEqual(['1', '2']);
    });
  });

  describe.each(['原始商品', '待处理'])('%s回收站批量恢复', managementTab => {
    function installRecycleBin({ blocked = new Set(), waitForRestore } = {}) {
      const items = Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), name: `回收商品${index + 1}`, deletedAt: '2026-10-14T00:00:00Z' }));
      const restored = new Set();
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (input, init) => {
        const url = new URL(input, 'http://localhost');
        if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
        if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
        if (url.pathname === '/api/admin/products/batch-restore') {
          const { productIds } = JSON.parse(init.body);
          requests.push(productIds);
          if (waitForRestore) await waitForRestore;
          const success = productIds.filter(id => !blocked.has(id));
          success.forEach(id => restored.add(id));
          return jsonResponse({ success, failures: productIds.filter(id => blocked.has(id)).map(id => ({ id, reason: '存在已删除的同名商品，不能单独恢复' })) });
        }
        if (/^\/api\/admin\/products\/\d+\/restore$/.test(url.pathname)) {
          const id = url.pathname.split('/').at(-2);
          restored.add(id);
          return jsonResponse({ id });
        }
        if (url.pathname === '/api/admin/products') {
          const deleted = url.searchParams.get('deleted') === 'true';
          const rows = items.filter(item => deleted ? !restored.has(item.id) : restored.has(item.id));
          const page = Number(url.searchParams.get('page') || 1);
          return jsonResponse(paged(rows.slice((page - 1) * 10, page * 10), rows.length, page));
        }
        return jsonResponse(paged([]));
      }));
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      return requests;
    }

    test('跨页恢复所选商品，保留失败项并可重试', async () => {
      const user = userEvent.setup();
      const blocked = new Set(['12']);
      const requests = installRecycleBin({ blocked });
      render(<AdminPage initialAuthenticated />);
      await user.click(await screen.findByRole('button', { name: '商品管理' }));
      await user.click(screen.getByRole('button', { name: managementTab }));
      await user.click(screen.getByRole('checkbox', { name: '回收站' }));
      await user.click(await screen.findByRole('checkbox', { name: '选择 回收商品1' }));
      await user.click(screen.getByRole('button', { name: '下一页' }));
      await user.click(await screen.findByRole('checkbox', { name: '选择本页商品' }));
      await user.click(screen.getByRole('button', { name: '批量恢复' }));
      expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/恢复.*3.*商品/));
      expect(await screen.findByText(/成功 2 件，失败 1 件.*同名商品/)).toBeInTheDocument();
      expect(requests).toEqual([['1', '11', '12']]);
      expect(await screen.findByRole('checkbox', { name: '选择 回收商品12' })).toBeChecked();
      expect(screen.getByText('已选 1 件')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '批量删除' })).not.toBeInTheDocument();
      blocked.clear();
      await user.click(screen.getByRole('button', { name: '批量恢复' }));
      expect(await screen.findByText(/成功 1 件，失败 0 件/)).toBeInTheDocument();
      expect(requests).toEqual([['1', '11', '12'], ['12']]);
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 回收商品12' })).not.toBeInTheDocument());
      expect(screen.queryByRole('button', { name: '批量恢复' })).not.toBeInTheDocument();
    });

    test('取消不恢复，恢复进行中禁止重复提交和修改选择', async () => {
      const user = userEvent.setup();
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      const requests = installRecycleBin({ waitForRestore: pending });
      render(<AdminPage initialAuthenticated />);
      await user.click(await screen.findByRole('button', { name: '商品管理' }));
      await user.click(screen.getByRole('button', { name: managementTab }));
      await user.click(screen.getByRole('checkbox', { name: '回收站' }));
      await user.click(await screen.findByRole('checkbox', { name: '选择 回收商品1' }));
      window.confirm.mockReturnValueOnce(false);
      await user.click(screen.getByRole('button', { name: '批量恢复' }));
      expect(requests).toEqual([]);
      expect(screen.getByRole('checkbox', { name: '选择 回收商品1' })).toBeChecked();
      await user.click(screen.getByRole('button', { name: '批量恢复' }));
      expect(screen.getByRole('button', { name: '恢复中…' })).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: '选择本页商品' })).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: '回收站' })).toBeDisabled();
      expect(screen.getAllByRole('button', { name: '恢复商品' }).every(button => button.matches(':disabled'))).toBe(true);
      expect(screen.getByRole('button', { name: '清除选择' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: '恢复中…' }));
      expect(requests).toEqual([['1']]);
      finish();
      expect(await screen.findByText(/成功 1 件，失败 0 件/)).toBeInTheDocument();
    });

    test('请求失败保留选择，单个恢复后移除已选目标', async () => {
      const user = userEvent.setup();
      installRecycleBin();
      const handleFetch = fetch.getMockImplementation();
      fetch.mockImplementation((input, init) => input === '/api/admin/products/batch-restore'
        ? Promise.resolve(jsonResponse({ error: '服务暂不可用' }, 503)) : handleFetch(input, init));
      render(<AdminPage initialAuthenticated />);
      await user.click(await screen.findByRole('button', { name: '商品管理' }));
      await user.click(screen.getByRole('button', { name: managementTab }));
      await user.click(screen.getByRole('checkbox', { name: '回收站' }));
      await user.click(await screen.findByRole('checkbox', { name: '选择 回收商品1' }));
      await user.click(screen.getByRole('button', { name: '批量恢复' }));
      expect(await screen.findByText(/成功 0 件，失败 1 件.*服务暂不可用/)).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: '选择 回收商品1' })).toBeChecked();
      await user.click(within(screen.getByRole('row', { name: /回收商品1 / })).getByRole('button', { name: '恢复商品' }));
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 回收商品1' })).not.toBeInTheDocument());
      expect(screen.queryByRole('button', { name: '批量恢复' })).not.toBeInTheDocument();
    });
  });

  test('opens tag members as a product list', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async input => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/tags') return jsonResponse(paged([{ id: '1', name: 'region', value: 'US', productCount: '1' }]));
      if (url.pathname === '/api/admin/tags/products') return jsonResponse(paged([{ id: '9', name: '商品九', spec: '月付', shopId: '2', shopName: '商铺二' }]));
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标签' }));
    await user.click(await screen.findByRole('button', { name: '查看商品' }));
    expect(await screen.findByText('商品九')).toBeInTheDocument();
    expect(screen.getByText('月付')).toBeInTheDocument();
  });

  test('merges a tag value through an explicit target form', async () => {
    const user = userEvent.setup();
    const mergeBodies = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/tags') return jsonResponse(paged([
        { id: '1', name: 'region', value: 'US', productCount: '1' },
        { id: '2', name: 'region', value: 'CA', productCount: '1' },
      ]));
      if (url.pathname === '/api/admin/tags/merge') {
        mergeBodies.push(JSON.parse(init.body));
        return jsonResponse({ success: ['9'], skipped: ['10'], conflicts: [] });
      }
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage initialAuthenticated />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '标签' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择标签 region：US' }));
    const mergeButton = screen.getByRole('button', { name: '合并标签值' });
    expect(mergeButton).toBeDisabled();
    await user.click(await screen.findByRole('checkbox', { name: '选择标签 region：CA' }));
    await user.click(mergeButton);
    const dialog = screen.getByRole('dialog', { name: '合并标签值' });
    await user.clear(within(dialog).getByRole('textbox', { name: '目标标签值' }));
    await user.type(within(dialog).getByRole('textbox', { name: '目标标签值' }), '中国大陆');
    await user.click(within(dialog).getByRole('button', { name: '确认合并' }));
    expect(mergeBodies).toEqual([
      { name: 'region', value: 'US', nextName: 'region', nextValue: '中国大陆' },
      { name: 'region', value: 'CA', nextName: 'region', nextValue: '中国大陆' },
    ]);
  });

  test('edits arbitrary tag names and values without a fixed taxonomy', async () => {
    const user = userEvent.setup();
    let saved;
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost');
      if (url.pathname === '/api/auth/me') return jsonResponse({ ok: true });
      if (url.pathname === '/api/admin/shops') return jsonResponse(paged([{ id: 1, name: '测试店', platform: 'liandong', enabled: 1 }]));
      if (url.pathname === '/api/admin/shop-submissions') return jsonResponse(paged([]));
      if (url.pathname === '/api/admin/products') return jsonResponse(paged([{ id: 3, name: '原始商品', shop_name: '测试店', tags: [{ name: '旧条件', value: '旧值' }] }]));
      if (url.pathname === '/api/admin/products/3/tags') {
        if (init?.method === 'PUT') { saved = JSON.parse(init.body); return jsonResponse({ ok: true }); }
        return jsonResponse({ items: [{ name: '旧条件', value: '旧值' }] });
      }
      return jsonResponse({ error: 'Unhandled' }, 404);
    }));
    render(<AdminPage />);
    await user.click(await screen.findByRole('button', { name: '商品管理' }));
    await user.click(await screen.findByRole('button', { name: '待处理' }));
    await user.click(await screen.findByRole('button', { name: '编辑标签' }));
    const editor = screen.getByRole('dialog', { name: '编辑商品标签' });
    await user.click(within(editor).getByRole('button', { name: '删除标签 1' }));
    await user.click(within(editor).getByRole('button', { name: '新增标签' }));
    await user.type(within(editor).getByLabelText('标签名称 1'), '资格:校验方式');
    await user.type(within(editor).getByLabelText('标签值 1'), '新用户认证');
    await user.click(within(editor).getByRole('button', { name: '保存标签' }));
    expect(await screen.findByText('商品标签已保存')).toBeInTheDocument();
    expect(saved).toEqual({ items: [{ name: '资格:校验方式', value: '新用户认证' }] });
  });

  test('logs in, reviews submitted shops, and assigns products to standard products', async () => {
    const user = userEvent.setup();
    let authenticated = false;
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = new URL(input, 'http://localhost:3000');
      calls.push({ method: init?.method || 'GET', path: url.pathname + url.search, body: init?.body ? JSON.parse(init.body) : null });
      if (url.pathname === '/api/auth/me') return authenticated ? jsonResponse({ ok: true }) : jsonResponse({ error: 'Unauthorized' }, 401);
      if (url.pathname === '/api/auth/login' && (init?.method || 'GET') === 'POST') {
        authenticated = JSON.parse(init.body).password === 'secret';
        return authenticated ? jsonResponse({ ok: true }) : jsonResponse({ error: 'Invalid credentials' }, 401);
      }
      if (url.pathname === '/api/admin/shop-submissions') {
        return jsonResponse(paged([{ id: 7, name: '新店', url: 'https://wzyp.cn/shop/new', created_at: '2026-09-07 08:00:00' }]));
      }
      if (url.pathname === '/api/admin/shop-submissions/7/approve') return jsonResponse({ ok: true, shopId: 9 }, 202);
      if (url.pathname === '/api/admin/shop-submissions/protocols') return jsonResponse({ items: [{ id: 'liandong', name: '联动' }] });
      if (url.pathname === '/api/admin/shop-submissions/7/detect') return jsonResponse({ status: 'matched', protocol: 'liandong', products: [] });
      if (url.pathname === '/api/admin/shops') {
        return jsonResponse(paged([{ id: 1, name: '日刷plus', url: 'https://wzyp.cn/shop/a', platform: 'liandong', enabled: 1 }]));
      }
      if (url.pathname === '/api/admin/products') {
        return jsonResponse(paged([{ id: 3, name: '洗发水 500ml', spec: '500ml', shop_id: 1, shop_name: '日刷plus', standard_product_name: null, updated_at: '2026-09-07 08:00:00' }]));
      }
      if (url.pathname === '/api/admin/standard-products') {
        return jsonResponse(paged([{ id: 11, name: '洗发水', platform: '个护清洁', count: 2 }]));
      }
      if (url.pathname === '/api/admin/platforms') return jsonResponse(paged([{ id: 1, name: '个护清洁', standard_product_count: 1 }]));
      if (url.pathname === '/api/admin/products/standard-products/bind' && init?.method === 'POST') return jsonResponse({ success: ['3'], skipped: [], conflicts: [] }, 201);
      return jsonResponse({ error: `Unhandled ${url.pathname}` }, 404);
    }));

    render(<AdminPage />);

    expect(await screen.findByText('管理端登录')).toBeInTheDocument();
    await user.type(screen.getByLabelText('管理员密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录管理端' }));
    expect(await screen.findByText('新店')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '通过并抓取' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '通过并抓取' }));
    expect(await screen.findByText('商铺已通过，正在抓取数据')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '商品管理' }));
    const rawProductRow = await screen.findByRole('row', { name: /洗发水 500ml/ });
    expect(within(rawProductRow).getByText('日刷plus')).toBeInTheDocument();
    expect(screen.getByText('洗发水 500ml')).toBeInTheDocument();
    expect(screen.getByText('500ml')).toHaveClass('product-spec');
    expect(screen.getByTitle('待处理')).toHaveClass('standard-product-pill', 'is-unassigned');
    expect(screen.getByRole('button', { name: '选择标准商品' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '待处理' }));
    await user.click(screen.getByRole('button', { name: '选择标准商品' }));
    const picker = await screen.findByRole('dialog', { name: '选择标准商品' });
    await user.click(within(picker).getByRole('button', { name: /洗发水/ }));
    await waitFor(() => {
      const assignment = calls.find((call) => call.method === 'POST' && call.path === '/api/admin/products/standard-products/bind');
      expect(assignment.body).toEqual({ productIds: ['3'], standardProductId: 11, confirmOwnershipChange: false });
    });

    await user.click(screen.getByRole('button', { name: '商铺管理' }));
    const shopLink = await screen.findByRole('link', { name: /wzyp\.cn\/shop\/a/ });
    expect(shopLink.closest('td')).toHaveClass('shop-cell');
    expect(screen.getByText('启用')).toHaveClass('status-pill', 'is-enabled');
  });
});
