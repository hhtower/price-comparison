import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractionPayload } from '../src/ai/adaptive-batching.js';
import { publicationEvidenceConflict as check } from '../src/standardization/publication-evidence.js';

for (const [name, spec, body, field] of [
  ['即梦高级会员 首登质保2h', '', '首登质保1h。', 'warranty'],
  ['即梦高级会员 首次登录保障2小时', '', '首次登录保障60分钟。', 'warranty'],
  ['即梦高级会员', '', '首登质保2h；首登质保1h。', 'warranty'],
  ['ChatGPT Plus 账号 首登质保2小时', '1 month', '提供Plus账号密码2FA。仅质保下单后1小时内首次登录。', 'warranty'],
  ['ChatGPT Plus 账号 2h首登质保', '1 month', '下单后1小时内首次登录质保。', 'warranty'],
  ['ChatGPT Plus 账号 首登质保2小时', '1 month', '首次登录仅质保下单后1小时内。', 'warranty'],
  ['ChatGPT Free 提供账密和RT', '', '实际只提供RT，不提供账号密码。', 'credentials'],
  ['ChatGPT Free', '账密', '实际只交付RT。', 'credentials'],
  ['ChatGPT Free 提供账密', '', '仅RT，不带账号密码。', 'credentials'],
  ['ChatGPT Free 提供账密', '', '仅RT。', 'credentials'],
  ['ChatGPT Free 提供账号/密码', '', '实际只提供RT。', 'credentials'],
  ['ChatGPT Free 已接码', '已接码', '实际交付未接码账号。', 'sms_verification'],
  ['ChatGPT Free', '未接码', '实际交付已接码账号。', 'sms_verification'],
  ['即梦高级会员 到期才可续费', '', '支持提前续费。', 'renewal'],
  ['即梦高级会员', '', '到期后才可续费；支持提前续费。', 'renewal'],
] as const) for (const format of ['raw', 'text'] as const) test(`blocks concrete ${field} conflict (${format}): ${name} ${spec} ${body}`, () => {
  const raw = { name, spec, sourceData: { evidence: `<p>${body}</p>` } };
  const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'publication', ...raw });
  const reason = check(evidence, format);
  assert.ok(reason);
  assert.match(reason, new RegExp(field, 'u'));
  assert.match(reason, /name|spec|sourceData\.evidence/u);
});

for (const [name, spec, body] of [
  ['即梦高级会员', '', '质保以官方为准，可能支持提前续费。'],
  ['即梦高级会员 首登质保2h', '', '首登质保120分钟。'],
  ['即梦高级会员 2h炸车质保', '', '1h首登质保。'],
  ['即梦高级会员 首登质保2h', '', '炸车质保1h。'],
  ['即梦高级会员 首登质保2h', '', '登录教程：请在1h内导入。'],
  ['ChatGPT Plus 账号 首登质保2小时', '1 month', '下单后1小时内首次登录，使用教程见说明。'],
  ['ChatGPT Free 提供账密和RT', '', '不提供邮箱密码，只提供ChatGPT账密。'],
  ['ChatGPT Free 附赠邮箱账密', '', '实际只提供RT，不提供ChatGPT账号密码。'],
  ['ChatGPT Free 提供账密和RT', '', '带RT，附赠登录教程。'],
  ['ChatGPT Free', '', 'RT格式可选或账密格式可选。'],
  ['ChatGPT Free 已接码/未接码', '已接码', '提供已接码账号。'],
  ['ChatGPT Free 未接码', '', '首次登录需自行接码。'],
  ['ChatGPT Free 已接码', '', '可能需要再次手机验证。'],
  ['即梦高级会员 到期才可续费', '', '不支持提前续费。'],
  ['即梦高级会员', '', '到期可续费；支持提前续费。'],
  ['即梦高级会员', '', '月卡到期才可续费，年卡支持提前续费。'],
  ['即梦高级会员 首登质保2h', '', '其他商品首登质保1h。'],
  ['即梦高级会员', '', '新号首登质保2h，老号首登质保1h。'],
  ['即梦高级会员', '', '不支持提前续费，到期后才可续费。'],
  ['即梦高级会员', '', '禁止提前续费，到期后才可续费。'],
] as const) for (const format of ['raw', 'text'] as const) test(`missing or distinct-scope attributes do not block (${format}): ${name} ${spec} ${body}`, () => {
  const raw = { name, spec, sourceData: { evidence: `<p>${body}</p>` } };
  const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'publication', ...raw });
  assert.equal(check(evidence, format), null);
});

for (const format of ['raw', 'text'] as const) test('selected SMS status is checked against delivery, not an unselected menu: ' + format, () => {
  const raw = { name: 'ChatGPT Free 已接码/未接码', spec: '接码状态: 已接码', sourceData: { evidence: '<p>实际只交付未接码账号。</p>',
  } };
  const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'selected', ...raw });
  assert.match(check(evidence, format) ?? '', /sms_verification.*spec/u);
});

for (const format of ['raw', 'text'] as const) {
  test('labeled warranty days do not borrow adjacent term or import durations: ' + format, () => {
    const raw = { name: 'ChatGPT Plus 账号', spec: '导入时限: 2小时 / 期限: 1个月 / 质保天数: 30',
      sourceData: { evidence: '质保30天。' } };
    const input = format === 'raw' ? raw : buildExtractionPayload({ id: 'labeled-warranty', ...raw });
    assert.equal(check(input, format), null);
    assert.match(check({ ...input, sourceData: { evidence: '质保5天。' } }, format) ?? '', /spec declares 43200 minutes/u);
  });

  test('selected warranty label and value establish a same-SKU promise: ' + format, () => {
    const raw = { name: 'ChatGPT Plus 账号', spec: '首登质保: 2小时', sourceData: { evidence: '<p>首登质保1小时。</p>',
    } };
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'selected-warranty', ...raw });
    const reason = check(evidence, format);
    assert.match(reason ?? '', /warranty.*first_login/u);
    assert.match(reason ?? '', /spec declares 120 minutes/u);
    assert.match(reason ?? '', /sourceData\.evidence declares 60 minutes/u);
  });

  test('only one selected option pairs its own rendered label and value: ' + format, () => {
    for (const spec of [
      '导入时限: 2小时 / 首登质保: 1小时',
      '首登质保: 120分钟',
      '炸车质保: 2小时',
      '<b>首登质保</b>: 120分钟',
    ]) {
      const raw = { name: 'ChatGPT Plus 账号', spec, sourceData: { evidence: '<p>首登质保1小时。</p>' } };
      // Equivalent durations use a matching body; other scopes retain the one-hour promise.
      if (spec.includes('120分钟')) raw.sourceData.evidence = '<p>首登质保2小时。</p>';
      const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'option-scopes', ...raw });
      assert.equal(check(evidence, format), null, spec);
    }
    assert.equal(check({ name: 'ChatGPT Plus 账号', sourceData: {
      warrantyLabel: '首登质保', importDeadline: '2小时', evidence: '首登质保1小时。',
    } }, format), null);
  });
}

test('default raw rendering ignores hidden text and decodes markup only once', () => {
  assert.equal(check({
    name: '首登质保2h',
    sourceData: { evidence: '<script>首登质保1h</script><p>首登质保120分钟</p>' },
  }), null);
  assert.ok(check({ name: '首登质保2h', sourceData: { evidence: '&lt;b&gt;首登质保1h&lt;/b&gt;' } }, 'text'));
});

for (const format of ['raw', 'text'] as const) {
  test(`a warranty range retains its guaranteed minimum: ${format}`, () => {
    for (const body of ['28-30天质保', '质保28-30天', '28至30天质保', '质保28～30天', '28–30天质保', '质保28—30天']) {
      const raw = { name: 'Codex Plus 成品号 质保28天', sourceData: { evidence: `<p>${body}</p>` } };
      const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'warranty-range', ...raw });
      assert.equal(check(evidence, format), null, body);
      const stricter = { ...raw, name: 'Codex Plus 成品号 质保30天' };
      const stricterEvidence = format === 'raw' ? stricter : buildExtractionPayload({ id: 'warranty-range-strict', ...stricter });
      assert.match(check(stricterEvidence, format) ?? '', /^warranty conflict/u, body);
    }
  });

  test(`setting a password after login is conditional usage, not absent delivery: ${format}`, () => {
    const raw = { name: 'Muse 成品号', sourceData: {
      evidence: '<p>您收到账密后请及时登录。</p><p>登陆成功后如果没有账户密码请您马上设置账户密码（可以点击忘记了密码重置）。</p>',
    } };
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'password-setup', ...raw });
    assert.equal(check(evidence, format), null);
    const conflicting = { ...raw, name: 'Muse 成品号 提供账密', sourceData: {
      evidence: '<p>实际只交付RT，没有账户密码。</p>',
    } };
    const conflictingEvidence = format === 'raw' ? conflicting : buildExtractionPayload({ id: 'password-delivery', ...conflicting });
    assert.match(check(conflictingEvidence, format) ?? '', /^credentials conflict/u);
  });

  test(`conditional password setup preserves independent delivery claims in the same clause: ${format}`, () => {
    for (const [name, body] of [
      ['Muse 成品号 提供账密', '登陆成功后如果没有账户密码请重置密码（账号密码不随货）'],
      ['Muse 成品号 不带账密', '登陆成功后如果没有账户密码请设置密码（发货格式:账号-密码-2FA）'],
      ['Muse 成品号 不带账密', '已设置账号密码并随货交付（登陆成功后如果没有账户密码请重置密码）'],
      ['Muse 成品号 不带账密', '发货格式：已设置账号-密码-2FA（登陆成功后如果没有账户密码请重置密码）'],
      ['Muse 成品号 不带账密', '登陆成功后如果没有账户密码请设置账号密码并随货交付'],
    ]) {
      const raw = { name, sourceData: { evidence: `<p>${body}</p>` } };
      const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'password-independent-claim', ...raw });
      assert.match(check(evidence, format) ?? '', /^credentials conflict/u, body);
    }
  });

  test(`shop rating snapshots do not override the selected SKU warranty: ${format}`, () => {
    const raw = { name: 'ChatGPT Plus 月卡 · 质保5天', spec: '质保5天', sourceData: {
      evidence: '<p>当前规格质保5天。</p>',
      ratingText: { name: 'ChatGPT Plus成品号-质保10天/7天/5天/3天(月卡)', description: '质保10天。' },
    } };
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'rating-is-not-sale-evidence', ...raw });
    assert.equal(check(evidence, format), null);
    const conflicting = { ...raw, sourceData: { ...raw.sourceData, evidence: '<p>实际仅提供1天质保。</p>' } };
    const conflictingEvidence = format === 'raw' ? conflicting : buildExtractionPayload({ id: 'actual-warranty-conflict', ...conflicting });
    assert.match(check(conflictingEvidence, format) ?? '', /^warranty conflict/u);
  });
}

test('does not treat RT-only delivery disclaimers as provided credentials', () => {
  const name = 'plus【已接马带rt不带帐密】, sub2 CPA格式只能反代使用';
  for (const body of [
    '不含账号密码，只供反代使用。',
    '不需要账号密码，导入JSON即可。',
    '无需账号密码，导入JSON即可。',
    '不能用账号密码登录网页，只能反代使用。',
    '这是RT格式，不是账号密码。',
    '如需账号密码请购买其他套餐。',
  ]) {
    assert.equal(check({ name, sourceData: { evidence: body } }), null, body);
  }
});

test('still blocks an RT-only title when the body promises account credentials', () => {
  const reason = check({
    name: 'plus【已接马带rt不带帐密】, sub2 CPA格式只能反代使用',
    sourceData: { evidence: '实际提供Plus账号密码和2FA。' },
  });
  assert.match(reason ?? '', /credentials conflict/u);
});

for (const format of ['raw', 'text'] as const) {
  for (const body of [
    '<p>plus代充链接: https://example.invalid/plus；free账号质保30天。</p>',
    '<p>plus代充链接: https://example.invalid/plus</p><p>plus可以联系另购；当前账号质保30天。</p>',
    '<p>plus代充链接: https://example.invalid/plus，free账号质保30天</p>',
    '<p>plus代充链接: https://example.invalid/plus，账号质保30天</p>',
    '<p>plus代充链接: https://example.invalid/plus</p><p>plus可以联系另购。质保30天。</p>',
    '<p>plus代充链接: https://example.invalid/plus</p><p>86块plus，可以qq联系，当前账号质保30天</p>',
  ]) test(`sibling advert lines retain mixed current claims and independent sentences: ${format} ${body}`, () => {
    const raw = { name: 'ChatGPT Free 质保1小时', spec: '', sourceData: { evidence: body } };
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'mixed-advert-line', ...raw });
    assert.match(check(evidence, format) ?? '', /^warranty conflict/u);
  });

  test(`sibling navigation and contact adverts keep their scope before clause splitting: ${format}`, () => {
    for (const [name, body] of [
      ['free家宽gmail谷歌注册-账密2fa', '<p>质保首登 codex free 无订阅 @gmail.com后缀邮箱注册 成品号。</p><p>这个链接是未接马的,已接的在这</p><p>发货格式:邮箱----AI密码----2fa</p><p>其他邮箱注册free成品号:</p><p>@gmail.com注册free →</p><p>已接马@gmail.com注册free →</p><p>已接马@icloud.com注册free →</p>'],
      ['G-free普号 | 只有AT发货', '<p>生图专用,只有at,购买后1小时内质保首登,其他问题无售后。</p><p>plus代充链接,一对一教学,小白友好版: <a href="https://example.invalid/plus">https://example.invalid/plus</a></p><p>86块plus,30天质保,已开账密2fa的,可以qq联系!</p>'],
    ] as const) {
      const raw = { name, spec: '', sourceData: { evidence: body } };
      const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'scoped-advert', ...raw });
      assert.equal(check(evidence, format), null, name);
    }
  });

  test(`sibling scopes preserve independent current delivery and linked sale promises: ${format}`, () => {
    for (const [name, body, field] of [
      ['ChatGPT Free 未接码', '<p>其他邮箱注册free成品号:</p><p>已接码@gmail注册free →</p><p>实际交付已接码账号。</p>', 'sms_verification'],
      ['ChatGPT Free 未接码', '<p>其他邮箱注册free成品号:</p><p>本链接已接码账号 →</p>', 'sms_verification'],
      ['ChatGPT Free 质保1小时', '<p>plus代充链接: https://example.invalid/plus</p><p>实际交付free账号，质保30天，可以qq联系。</p>', 'warranty'],
      ['ChatGPT Free 质保1小时', '<p>plus代充链接: https://example.invalid/plus</p><p>本商品plus账号，质保30天，可以qq联系。</p>', 'warranty'],
      ['ChatGPT Free 质保1小时', '<p>plus代充链接: https://example.invalid/plus</p><p>plus也可购买，free账号质保30天，可以qq联系。</p>', 'warranty'],
      ['ChatGPT Plus 质保1小时', '<p>plus代充链接: https://example.invalid/plus</p><p>86块plus,30天质保,可以qq联系!</p>', 'warranty'],
      ['ChatGPT Free 不带账密', '<p><a href="https://example.invalid/free">实际交付free账号账密2fa</a></p>', 'credentials'],
      ['ChatGPT Free 未接码', '<p>其他邮箱注册free成品号:</p><p>已接码@gmail注册free</p>', 'sms_verification'],
    ] as const) {
      const raw = { name, spec: '', sourceData: { evidence: body } };
      const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'scoped-current', ...raw });
      assert.match(check(evidence, format) ?? '', new RegExp(`^${field} conflict`, 'u'), name + body);
    }
  });

  test(`a duration before a forward warranty promise is validity, not another warranty: ${format}`, () => {
    const raw = { name: 'icloud隐私邮箱20天质保3天', spec: '', sourceData: {
      evidence: '<p>质保3天，有效期20天（首次使用开始计时）。</p>',
    } };
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'mail-validity', ...raw });
    assert.equal(check(evidence, format), null);
    const conflicting = { ...raw, sourceData: { evidence: '<p>质保1天，有效期20天。</p>' } };
    const conflictingEvidence = format === 'raw' ? conflicting : buildExtractionPayload({ id: 'mail-conflict', ...conflicting });
    assert.match(check(conflictingEvidence, format) ?? '', /warranty conflict/u);
    assert.match(check({ name: '邮箱20天质保', sourceData: { evidence: '质保3天。' } }, format) ?? '', /warranty conflict/u);
  });

  test(`JSON delivery excludes account credentials explicitly: ${format}`, () => {
    const raw = { name: '已接马 FREE号 反代专用 发货json 没有账号密码', spec: '', sourceData: {
      evidence: '<p>给的是free号的JSON。发货JSON 不包括账号密码。</p>',
    } };
    const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'json-no-credentials', ...raw });
    assert.equal(check(evidence, format), null);
    const conflicting = { ...raw, sourceData: { evidence: '<p>发货JSON 包括账号密码。</p>' } };
    const conflictingEvidence = format === 'raw' ? conflicting : buildExtractionPayload({ id: 'json-credentials', ...conflicting });
    assert.match(check(conflictingEvidence, format) ?? '', /credentials conflict/u);
    assert.match(check({ name: 'Free号 提供账号密码', sourceData: raw.sourceData }, format) ?? '', /credentials conflict/u);
  });
}

test('recognizes credential delivery formats and trailing denials', () => {
  const title = 'ChatGPT Plus RT 不带账密';
  for (const body of [
    '账号密码不提供，只有RT。',
    '账号密码：不提供。',
    '账号密码（不提供）。',
    '账号密码 - 不提供。',
    '账号密码/不提供。',
    '账号密码，不提供。',
    '发货格式：账号-密码-RT。',
    '发货格式：账号+密码+RT。',
    '文件中包含 email|password|totp。',
  ]) {
    const reason = check({ name: title, sourceData: { evidence: body } });
    if (body.includes('不提供')) assert.equal(reason, null, body);
    else assert.match(reason ?? '', /credentials conflict/u);
  }
});

for (const format of ['raw', 'text'] as const) {
  test(`credential usage notes do not change delivery promises: ${format}`, () => {
    for (const name of ['ChatGPT Plus 不带账密', 'ChatGPT Plus 提供账密']) {
      for (const body of ['无需账号密码，导入JSON即可。', '不需要账号密码，导入JSON即可。',
        '账号密码仅用于说明。', '账号密码不是交付内容。', '账号密码仅作示例。',
        '账号密码为格式说明。', '不能使用账号密码登录网页。']) {
        assert.equal(check({ name, sourceData: { evidence: body } }, format), null, body);
      }
    }
    for (const body of ['实际提供账号密码和2FA。', '实际提供账号密码仅用于教程演示。']) {
      assert.match(check({ name: 'ChatGPT Plus 不带账密',
        sourceData: { evidence: body } }, format) ?? '', /credentials conflict/u);
    }
  });

  test(`pipe-separated offers retain separate SKU scopes: ${format}`, () => {
    assert.equal(check({ name: 'ChatGPT Plus 账号',
      sourceData: { evidence: '月卡首登质保1小时 | 年卡首登质保2小时' } }, format), null);
    assert.equal(check({ name: 'ChatGPT Plus RT 不带账密',
      sourceData: { evidence: 'RT|账密格式可选。' } }, format), null);
    assert.match(check({ name: 'ChatGPT Plus 不带账密',
      sourceData: { evidence: '文件中包含 email | password | totp。' } }, format) ?? '', /credentials conflict/u);
  });
}

for (const format of ['raw', 'text'] as const) {
  test(`sibling listings, comparisons and title menus do not block: ${format}`, () => {
    for (const [name, spec, body] of [
      ['强推 Plus 成品号 UPI印度渠道 已接马 质保24H', '', '介意勿拍,可以下单本店的未接码商品,搭配长效接码使用。'],
      ['Plus 已接马|质保首登|(店铺还有未接马的)', '', '提供账号密码2fa。'],
      ['Gfree 成品号-iCloud邮箱注册', '', '本链接是未接马,需要已接马见下面链接<br>已接马@gmail.com注册free → https://example.invalid/item/a'],
      ['G Free 成品号', '', '这款是未接马的 !!! 那这款根本就不适用 !可以去下单已接马的 !拍错不售后 !'],
      ['越南号 实卡', '', '质保1天 ,此类账号相对稳定 和成品号质保20天 28天是同一类产品'],
      ['SuperGrok成品号|质保12天', '', '质保12天订阅。怕掉订阅可以拍30天质保,更省心!'],
      ['G Plus 成品号(30 天质保)', '', '质保规则:1.收货一周内封禁换新;3.30 天质保覆盖封号'],
      ['ChatGPT Plus成品号-质保10天/7天/5天(月卡) · 质保5天', '质保5天', ''],
      ['小白反代教程|已接马PLUS|未接马PLUS', '', ''],
    ] as const) {
      const raw = { name, spec, sourceData: { evidence: `<p>${body}</p>` } };
      const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'sibling', ...raw });
      assert.equal(check(evidence, format), null, name);
    }
  });

  test(`real same-SKU contradictions still block and quote both clauses: ${format}`, () => {
    for (const [name, body, field] of [
      ['【新鲜出炉】Plus 成品号|30天质保', '【售后政策】 ✓ 3天质保', 'warranty'],
      ['已接马-free-家宽邮箱注册-账密2fa', '目前都是未接马的,后续会上接马的', 'sms_verification'],
      ['plus【已接马带rt不带帐密】 ,sub2 CPA格式', '发货为:账密2fa', 'credentials'],
      ['Plus 质保1.5天', '质保3天', 'warranty'],
    ] as const) {
      const raw = { name, spec: '', sourceData: { evidence: `<p>${body}</p>` } };
      const evidence = format === 'raw' ? raw : buildExtractionPayload({ id: 'real', ...raw });
      const reason = check(evidence, format) ?? '';
      assert.match(reason, new RegExp(`^${field} conflict`, 'u'), name);
      assert.match(reason, /「.+」 vs 「.+」/u, name);
    }
  });
}
