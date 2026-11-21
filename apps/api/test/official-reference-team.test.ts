import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REFERENCE_WEBSITES } from '@price-comparison/catalog/official-reference';
import { parseTeamReference } from '../src/official-reference/official-reference.team.js';

const business = `<article><div><h3>Business</h3><p>A secure workspace.</p></div>
  <div>
    <section><div><h4>Standard seat</h4><div><span>$20</span><span>/ month</span></div></div>
      <p>Best for everyday work</p><p>$20/month if billed annually. $25/month if billed monthly.</p></section>
    <section><div><h4>Premium seat</h4><div>$100/ month</div></div>
      <p>More usage</p><p>$100/month if billed annually. $125/month if billed monthly.</p></section>
  </div></article>`;
const claude = `<div><div><h3>Team</h3><p>For teams of 2 to 150</p></div><a>Get Team plan</a>
  <div>
    <div><div><div><p>Standard seat</p><p>All Claude features, plus more usage than Pro*</p></div><p>$20</p></div>
      <div>Per seat / month if billed annually. <span>$25</span> if billed monthly.</div></div>
    <div><div><div><p>Premium seat</p><p>More usage</p></div><p>$100</p></div>
      <div>Per seat / month if billed annually. <span>$125</span> if billed monthly.</div></div>
  </div></div>`;
const fixtures = [['chatgpt-business', business], ['claude-team', claude]] as const;
const teamTab = (content: string) => `<div role="tablist">
  <button id="pricing-plans-tab-1" role="tab" aria-controls="pricing-plans-panel-1">Team &amp; Enterprise</button>
  </div><div id="pricing-plans-panel-1" role="tabpanel" aria-labelledby="pricing-plans-tab-1" hidden>${content}</div>`;
const stream = (content: string) => `<main><!--$?--><template id="B:0"></template><!--/$--></main>
  <div hidden id="S:0">${content}</div><script>$RC("B:0","S:0")</script>`;

test('Claude exposes only the hidden panel linked both ways to the Team & Enterprise tab', () => {
  assert.deepEqual(parseTeamReference('claude-team', teamTab(claude)).offers,
    parseTeamReference('claude-team', claude).offers);
  assert.deepEqual(parseTeamReference('claude-team', teamTab(claude.replace('$25', '$27.29'))).offers
    .map(offer => offer.amount), [27.29, 240, 125, 1200]);
  assert.deepEqual(parseTeamReference('claude-team', teamTab(
    `<div hidden>${claude.replace('$25', '$1')}</div>${claude}`)).offers,
  parseTeamReference('claude-team', claude).offers);
  assert.throws(() => parseTeamReference('chatgpt-business', teamTab(business)));
});

test('Claude rejects forged, missing, ambiguous, hidden or mismatched tab relationships', () => {
  const html = teamTab(claude);
  for (const changed of [
    html.replace('role="tab"', 'role="button"'),
    html.replace('role="tabpanel"', 'role="region"'),
    html.replace('Team &amp; Enterprise', 'Individual'),
    html.replace('aria-controls="pricing-plans-panel-1"', 'aria-controls="unrelated"'),
    html.replace('aria-labelledby="pricing-plans-tab-1"', 'aria-labelledby="unrelated"'),
    html.replace('<button', '<button hidden'),
    html.replace('<button', '<button style="display:none"'),
    html.replace('<button', '<span').replace('</button>', '</span>'),
    html.replace(' hidden>', ' hidden aria-hidden="true">'),
    html.replace(' hidden>', ' hidden style="display:none">'),
    html.replace('id="pricing-plans-panel-1"', 'id="forged-panel"'),
    `<div hidden>${html}</div>`,
    `<template>${html}</template>`,
    html + '<div id="pricing-plans-panel-1"></div>',
    html + '<button id="pricing-plans-tab-1"></button>',
  ]) assert.throws(() => parseTeamReference('claude-team', changed));
  assert.throws(() => parseTeamReference('claude-team', teamTab(
    claude.replaceAll('$25', '<span hidden>$25</span>'))));
});

test('OpenAI exposes only the segment named by a direct stream insertion with an existing template', () => {
  assert.deepEqual(parseTeamReference('chatgpt-business', stream(business)).offers,
    parseTeamReference('chatgpt-business', business).offers);
  const bootstrap = '$RB=[];$RV=function(a){return "$RC(\\"B:9\\",\\"S:9\\")";};\n'
    + '$RC=function(a,b){if(b){a.previousSibling.data="$~";}};$RC("B:0","S:0")';
  assert.deepEqual(parseTeamReference('chatgpt-business', stream(business)
    .replace('$RC("B:0","S:0")', bootstrap)).offers, parseTeamReference('chatgpt-business', business).offers);
  assert.deepEqual(parseTeamReference('chatgpt-business', stream(business.replaceAll('$20', '$20.29'))).offers
    .map(offer => offer.amount), [25, 243.48, 125, 1200]);
  assert.deepEqual(parseTeamReference('chatgpt-business', stream(
    `<div hidden>${business.replaceAll('$25', '$1')}</div>${business}`)
    + `<div hidden id="S:9">${business.replaceAll('$25', '$2')}</div>`).offers,
  parseTeamReference('chatgpt-business', business).offers);
  assert.throws(() => parseTeamReference('claude-team', stream(claude)));
});

test('OpenAI rejects unreferenced, duplicate, mismatched and hidden stream markers', () => {
  const html = stream(business);
  for (const changed of [
    html.replace('<template id="B:0"></template>', ''),
    html.replace('template', 'div'),
    html.replace('id="B:0"', 'id="B:1"'),
    html.replace('id="S:0"', 'id="S:1"'),
    html.replace('<script>', '<script type="application/json">'),
    html.replace('<script>', '<script src="/ignored.js">'),
    html.replace('<script>', '<script hidden>'),
    html.replace('<main>', '<main hidden>'),
    html.replace('hidden id="S:0"', 'hidden aria-hidden="true" id="S:0"'),
    html.replace('hidden id="S:0"', 'hidden style="display:none" id="S:0"'),
    html + '<template id="B:0"></template>',
    html + '<div id="S:0"></div>',
    html + '<script>$RC("B:0","S:0")</script>',
    `<script>$RC("B:0","S:0")</script><template id="B:0"></template><div hidden id="S:0">${business}</div>`,
    `<div hidden>${html}</div>`,
  ]) assert.throws(() => parseTeamReference('chatgpt-business', changed));
  for (const script of ['', '$RC("B:1","S:0")', '$RC("B:0","S:1")',
    '//;$RC("B:0","S:0")', '/* $RC("B:0","S:0") */',
    '<!--;$RC("B:0","S:0")', '-->;$RC("B:0","S:0")',
    'const fake = \'$RC("B:0","S:0")\';', '`$RC("B:0","S:0")`',
    '$R/**/C("B:0","S:0")', 'const fake = `outer ${`;$RC("B:0","S:0");`}`;',
    'if(false){$RC("B:0","S:0")}', 'function fake(){$RC("B:0","S:0")}',
    'const fake = /;$RC("B:0","S:0")/;', 'other.$RC("B:0","S:0")']) {
    assert.throws(() => parseTeamReference('chatgpt-business', html.replace('$RC("B:0","S:0")', script)), script);
  }
  assert.throws(() => parseTeamReference('chatgpt-business', stream(
    business.replaceAll('$25', '<span hidden>$25</span>'))));
});

for (const [appId, html] of fixtures) {
  test(`${appId}: complete metadata, actual monthly charge and annual total`, () => {
    const before = Date.now();
    const snapshot = parseTeamReference(appId, html);
    const source = REFERENCE_WEBSITES.find(item => item.id === appId)!;
    assert.equal(snapshot.appId, appId);
    assert.notEqual(snapshot.appId, source.appId);
    assert.equal(snapshot.country, source.country);
    assert.equal(snapshot.currency, 'USD');
    assert.equal(snapshot.sourceUrl, source.website);
    assert.ok(Date.parse(snapshot.capturedAt) >= before && Date.parse(snapshot.capturedAt) <= Date.now());
    assert.deepEqual(snapshot.offers.map(offer => [offer.amount, offer.formatted]),
      [[25, '$25.00'], [240, '$240.00'], [125, '$125.00'], [1200, '$1,200.00']]);
    assert.deepEqual(snapshot.offers.map(({ id, name, period, unit, kind }) => ({ id, name, period, unit, kind })),
      source.plans.map(({ id, name, period, unit }) => ({ id, name, period, unit, kind: 'subscription' })));
  });

  test(`${appId}: changed prices and cent-exact annual multiplication`, () => {
    const changed = html.replaceAll('$20', '&#36;20.29').replaceAll('$25', '$26.57')
      .replaceAll('$100', '$1,234.56').replaceAll('$125', '$1,500.01');
    assert.deepEqual(parseTeamReference(appId, changed).offers.map(offer => [offer.amount, offer.formatted]),
      [[26.57, '$26.57'], [243.48, '$243.48'], [1500.01, '$1,500.01'], [14814.72, '$14,814.72']]);
  });

  test(`${appId}: scopes seats to the named plan, excluding Pro, Enterprise and FAQ`, () => {
    const other = html.replace(appId === 'claude-team' ? '>Team<' : '>Business<', '>Enterprise<')
      .replaceAll('$20', '$999');
    assert.deepEqual(parseTeamReference(appId, other + html + other).offers, parseTeamReference(appId, html).offers);
    assert.throws(() => parseTeamReference(appId, other));
    assert.throws(() => parseTeamReference(appId, html.replace(
      appId === 'claude-team' ? '>Team<' : '>Business<', '>Pro<')));
    assert.throws(() => parseTeamReference(appId, `<h3>${appId === 'claude-team' ? 'Team' : 'Business'}</h3>${other}`));
  });

  test(`${appId}: accepts identical duplicates but rejects any conflicting or incomplete card`, () => {
    assert.deepEqual(parseTeamReference(appId, html + html).offers, parseTeamReference(appId, html).offers);
    assert.throws(() => parseTeamReference(appId, html + html.replaceAll('$125', '$126')), /conflict/i);
    assert.throws(() => parseTeamReference(appId, html + html.replaceAll('$25', 'Contact sales')));
    assert.throws(() => parseTeamReference(appId, html.replaceAll('Premium seat', 'Unavailable seat')));
    assert.throws(() => parseTeamReference(appId, html.slice(0, html.indexOf('Premium seat'))));
    assert.throws(() => parseTeamReference(appId, html.replaceAll('Standard seat', 'Unavailable seat')));
  });

  test(`${appId}: hidden, script and template evidence never supplies or overrides a quote`, () => {
    for (const tag of ['script', 'style', 'template', 'noscript']) {
      assert.throws(() => parseTeamReference(appId, `<${tag}>${html}</${tag}>`));
      assert.deepEqual(parseTeamReference(appId, `<${tag}>${html.replaceAll('$25', '$1')}</${tag}>${html}`).offers,
        parseTeamReference(appId, html).offers);
    }
    assert.throws(() => parseTeamReference(appId, `<svg><foreignObject>${html}</foreignObject></svg>`));
    for (const attribute of ['hidden', 'aria-hidden="true"', 'style="display:none"',
      'style="visibility: hidden !important"', 'role="tabpanel" hidden']) {
      assert.throws(() => parseTeamReference(appId, `<div ${attribute}>${html}</div>`));
      assert.deepEqual(parseTeamReference(appId, `<div ${attribute}>${html.replaceAll('$25', '$1')}</div>${html}`).offers,
        parseTeamReference(appId, html).offers);
    }
    assert.throws(() => parseTeamReference(appId, html.replaceAll('$25', '<span hidden>$25</span>')
      + `<script>${html}</script><p>Standard seat $25/month</p>`));
  });

  test(`${appId}: invalid currencies, units, values and incomplete billing terms fail closed`, () => {
    for (const value of ['$0', '$-25', '$NaN', '$1e2', '$25.001', '$1,23', '$1000000000001',
      'EUR 25', 'CA$25', '$25 CAD', '\u20ac25']) {
      assert.throws(() => parseTeamReference(appId, html.replaceAll('$25', value)), value);
    }
    assert.throws(() => parseTeamReference(appId, html.replaceAll('/ month', '/ year').replaceAll('/month', '/year')));
    assert.throws(() => parseTeamReference(appId, html.replaceAll('billed monthly', 'billed weekly')));
    assert.throws(() => parseTeamReference(appId, html.replaceAll('billed annually', 'billed monthly')));
    assert.throws(() => parseTeamReference(appId, html.replaceAll('$20', '$0')));
    assert.throws(() => parseTeamReference(appId, html.replaceAll('$20', '$1000000000000')));
    assert.throws(() => parseTeamReference(appId, html.replace('</h3>', '</h3><p>Prices in CAD</p>')));
  });
}

test('Business requires explicit billing evidence and rejects inconsistent display or duplicate prices', () => {
  const quote = '<p>$20/month if billed annually. $25/month if billed monthly.</p>';
  for (const replacement of ['', '<p>$20/month</p>', '<p>Trial: $20/month if billed annually. $25/month if billed monthly.</p>',
    '<h4>Enterprise</h4>' + quote, '<script>' + quote + '</script>']) {
    assert.throws(() => parseTeamReference('chatgpt-business', business.replace(quote, replacement)), replacement);
  }
  assert.throws(() => parseTeamReference('chatgpt-business', business.replace('<span>$20</span>', '<span>$21</span>')));
  assert.throws(() => parseTeamReference('chatgpt-business', business.replace(quote,
    quote + quote.replace('$25', '$26'))), /conflict/i);
  assert.throws(() => parseTeamReference('chatgpt-business', business.replace(quote, '')
    + `<section><h4>FAQ</h4>${quote}</section>`));
});

test('Claude binds the annual price to its own billing note and requires seat units', () => {
  for (const replacement of ['', '<p>Trial $20</p>', '<p>EUR 20</p>',
    '<p>$20</p><h4>Enterprise</h4>', '<p>$20</p><p>$19</p>']) {
    assert.throws(() => parseTeamReference('claude-team', claude.replace('<p>$20</p>', replacement)), replacement);
  }
  assert.throws(() => parseTeamReference('claude-team', claude.replace('Per seat', 'Per user')));
  assert.throws(() => parseTeamReference('claude-team', claude.replace(
    '<div><p>Standard seat</p><p>All Claude features, plus more usage than Pro*</p></div><p>$20</p>',
    '<p>$20</p><div><p>Standard seat</p><p>All Claude features, plus more usage than Pro*</p></div>')));
  assert.throws(() => parseTeamReference('claude-team', claude.replace('<p>$20</p>', '')
    + '<p>$20 Per seat / month if billed annually. $25 if billed monthly.</p>'));
});

test('unsupported source IDs and oversized HTML reject', () => {
  for (const id of ['', 'cursor', 'google-ai', '6448311069', 'https://openai.com/business/pricing/']) {
    assert.throws(() => parseTeamReference(id, business));
  }
  assert.throws(() => parseTeamReference('chatgpt-business', ' '.repeat(4 * 1024 * 1024 + 1)));
});
