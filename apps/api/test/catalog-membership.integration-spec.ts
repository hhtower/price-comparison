import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { Pool } from 'pg';
import { migrationProvider } from '../scripts/migrate.js';
import { createPostgresPool } from '../src/database/database.providers.js';
import { jsonb, type JsonValue, type DatabaseSchema } from '../src/database/types.js';
import { CatalogRepository } from '../src/catalog/catalog.repository.js';
import { CatalogService, normalizeCatalogQuery } from '../src/catalog/catalog.service.js';
import { CatalogController } from '../src/catalog/catalog.controller.js';
import { publishNextCatalogChange } from '../src/catalog/catalog-projection.js';
import { recordCandidateCatalogChanges } from '../src/catalog/catalog-version.repository.js';
import { createCache } from '../src/cache/cache.js';
import { buildMembershipFeatures } from '../src/standardization/membership-classification.js';
import { MEMBERSHIP_KINDS, type MembershipKind } from '@price-comparison/catalog/membership-policy';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

describe('membership catalog features share standard identities', { skip: !process.env.TEST_DATABASE_URL }, () => {
  const schema = `membership_catalog_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let db: Kysely<DatabaseSchema>;
  let repository: CatalogRepository;
  let service: CatalogService;
  const cache = createCache();
  const ids: Record<string, string> = {};
  const products: Record<string, string> = {};

  async function saveFeature(id: string, kind: MembershipKind) {
    const product = await db.selectFrom('products').selectAll().where('id', '=', BigInt(id)).executeTakeFirstOrThrow();
    await db.updateTable('products').set({ membership_features: jsonb(buildMembershipFeatures([], product, [], kind) as unknown as JsonValue) })
      .where('id', '=', BigInt(id)).execute();
  }

  before(async () => {
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`create schema "${schema}"`);
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: createPostgresPool({
      DATABASE_URL: process.env.TEST_DATABASE_URL, PG_SCHEMA: schema,
    }) }) });
    const { error } = await new Migrator({ db, provider: migrationProvider, migrationTableSchema: schema }).migrateToLatest();
    if (error) throw error;
    repository = new CatalogRepository(db);
    service = new CatalogService(repository, cache);
    const shop = (await sql<{ id: string }>`insert into shops (name, platform, url)
      values ('Membership shop', 'test', 'https://membership.invalid') returning id::text`.execute(db)).rows[0]!.id;
    for (const [key, family, product, tier, kind, price, delivery, days] of [
      ['base', 'openai', 'chatgpt', 'plus', null, null, null, null],
      ['account', 'openai', 'chatgpt', 'plus', 'account', '28', 'redemption', '28'],
      ['top_up', 'openai', 'chatgpt', 'plus', 'top_up', '50', 'top_up', '60'],
      ['rental', 'openai', 'chatgpt', 'plus', 'rental', '6', 'account', '99'],
      ['short_term', 'openai', 'chatgpt', 'plus', 'short_term', '1', 'account', '99'],
      ['pending', 'anthropic', 'claude', 'pro', null, '2', 'account', '99'],
      ['youtube', 'youtube', 'youtube', 'individual', null, '3', 'redemption', '1'],
      ['free', 'openai', 'chatgpt', 'free', null, '4', 'account', '1'],
    ] as const) {
      const standard = kind ? ids.base! : (await sql<{ id: string }>`insert into standard_products
        (name, platform, canonical_family, canonical_product, canonical_tier, verification_state, hidden)
        values (${`${family} / ${product} / ${tier}`}, ${family}, ${family}, ${product}, ${tier}, 'verified', false)
        returning id::text`.execute(db)).rows[0]!.id;
      ids[key] = standard;
      if (!price) continue;
      const source = (await sql<{ id: string }>`insert into products (shop_id, external_id, name, spec, normalized_key, url)
        values (${shop}::bigint, ${key}, ${key}, '', ${key}, ${`https://membership.invalid/${key}`}) returning id::text`.execute(db)).rows[0]!.id;
      products[key] = source;
      if (kind) await saveFeature(source, kind);
      await sql`insert into standard_product_members (standard_product_id, product_id, publication_state, assignment_source)
        values (${standard}::bigint, ${source}::bigint, 'published', 'ai')`.execute(db);
      await sql`insert into product_tags (product_id, name, value) values
        (${source}::bigint, 'delivery', ${delivery}), (${source}::bigint, 'warranty_days', ${days})`.execute(db);
      if (key === 'rental' || key === 'youtube') {
        await sql`insert into product_tags (product_id, name, value)
          values (${source}::bigint, 'access', ${key === 'rental' ? 'dedicated' : 'shared'})`.execute(db);
      }
      await sql`insert into offers (product_id, idempotency_key, price, currency, captured_at, stock_available, is_stale)
        values (${source}::bigint, ${key}, ${price}::numeric, 'CNY', now(), true, false)`.execute(db);
    }
    while (await publishNextCatalogChange(db)) {}
  });

  after(async () => {
    await cache.disconnect();
    await db?.destroy();
    if (admin) {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  });

  test('SQL candidates, counts, facets and cursors share hard AI-only scope', async () => {
    const page = await repository.search({ newcomer: true, tags: [], limit: 100 });
    assert.deepEqual(new Set(page.items.map(item => item.id)), new Set(['account', 'top_up', 'youtube', 'free'].map(key => ids[key])));
    assert.equal(page.total, 3);
    assert.equal(page.offerTotal, 4);
    const ai = page.items.find(item => item.id === ids.base)!;
    assert.equal('membershipKind' in ai, false);
    assert.equal(ai.offers[0]?.membershipKind, 'account');
    assert.deepEqual(ai.membershipGroups?.map(group => group.kind), ['account', 'top_up']);
    assert.equal(ai.productCount, 2);
    assert.equal(ai.shopCount, 1);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const slice = await repository.search({ newcomer: true, tags: [], limit: 1, cursor });
      seen.push(...slice.items.map(item => item.id));
      assert.equal(slice.total, 3);
      cursor = slice.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, page.items.map(item => item.id));
    const facets = await repository.facets({ newcomer: true, tags: [] });
    assert.ok(!facets.tagFacets.some(tag => tag.name === 'warranty_days' && tag.value === '99'));
    assert.equal(facets.tagFacets.find(tag => tag.name === 'delivery' && tag.value === 'account')?.priority, 1);
  });

  test('explicit kind overrides newcomer and delivery tags remain independent', async () => {
    const short = await service.getCatalog({ newcomer: true, membershipKinds: ['short_term'] });
    assert.deepEqual(short.items.map(item => item.id), [ids.short_term, ids.pending]);
    const rental = await service.getCatalog({ newcomer: true, membershipKinds: ['rental'] });
    assert.deepEqual(rental.items.map(item => item.id), [ids.rental]);
    assert.equal(rental.items[0]?.offers[0]?.membershipKind, 'rental');
    assert.equal((await service.getCatalog({ membershipKinds: ['account', 'top_up', 'rental', 'short_term'] })).total, 2);
    const account = await service.getCatalog({ newcomer: true, membershipKind: 'account', tag: { name: 'delivery', value: 'redemption' } });
    assert.deepEqual(account.items.map(item => item.id), [ids.account]);
    assert.equal((await service.getCatalog({ membershipKind: 'account', warrantyDaysMin: 30 })).total, 0);
    assert.equal((await service.getCatalog({ newcomer: true, standardProductId: ids.base, priceMax: '5' })).total, 0);
    assert.equal((await service.getCatalog({ newcomer: false, standardProductId: ids.base, priceMax: '5' })).total, 1);
  });

  test('natural-language category searches apply membership semantics only to AI products', async () => {
    assert.deepEqual((await service.getCatalog({ q: 'ChatGPT 成品号', newcomer: true })).items.map(item => item.id), [ids.account]);
    assert.deepEqual((await service.getCatalog({ q: 'ChatGPT短期', newcomer: true })).items.map(item => item.id), [ids.short_term]);
    assert.deepEqual((await service.getCatalog({ q: 'ChatGPT 代充' })).items.map(item => item.id), [ids.top_up]);
    assert.deepEqual((await service.getCatalog({ q: '成品账号' })).items.map(item => item.id).sort(),
      [ids.account, ids.free].sort());
    assert.equal((await service.getCatalog({ q: '短期', searchMode: 'literal' })).total, 0);
    const oldDelivery = await service.getCatalog({ tag: { name: 'delivery', value: 'account' }, newcomer: false });
    assert.ok(oldDelivery.items.some(item => item.id === ids.short_term));
    assert.ok(!oldDelivery.items.flatMap(item => item.membershipGroups ?? []).some(group => group.kind === 'account'));
  });

  test('rental searches consume labels only for AI and preserve explicit access and non-AI filters', async () => {
    for (const term of ['租号', '共享', '合租', '租号（共享）', '租号 ( 合租 )']) {
      assert.deepEqual((await service.getCatalog({ q: `ChatGPT ${term}`, newcomer: true })).items.map(item => item.id),
        [ids.rental], term);
      assert.equal((await service.getCatalog({ q: `ChatGPT ${term}`, searchMode: 'literal' })).total, 0);
      assert.equal((await service.getCatalog({ q: `ChatGPT 不要${term}` })).total, 0);
    }
    for (const term of ['共享', '合租']) {
      assert.deepEqual(new Set((await service.getCatalog({ q: term, newcomer: true })).items.map(item => item.id)),
        new Set([ids.rental, ids.youtube]));
      assert.deepEqual((await service.getCatalog({ q: `youtube ${term}`, newcomer: true })).items.map(item => item.id), [ids.youtube]);
      assert.equal((await service.getCatalog({ q: `ChatGPT ${term}`, tag: { name: 'access', value: 'shared' } })).total, 0);
    }
    for (const q of ['ChatGPT 共享未说明', 'ChatGPT 不接受合租', 'ChatGPT 租号(共享)未知']) {
      assert.equal((await service.getCatalog({ q, newcomer: true })).total, 0, q);
    }
    const facets = await service.getFacets({ membershipKinds: ['rental'], newcomer: true });
    assert.equal(facets.tagFacets.find(tag => tag.name === 'access' && tag.value === 'dedicated')?.priority, 1);
  });

  test('assistant reference reads enforce the same scope before returning candidates', async () => {
    assert.deepEqual((await service.getReferenceOffers({ standardProductId: ids.base, newcomer: true })).map(offer => offer.membershipKind), ['account', 'top_up']);
    assert.equal((await service.getReferenceOffers({ standardProductId: ids.rental, membershipKinds: ['rental'], newcomer: true }))[0]?.membershipKind, 'rental');
    assert.equal((await service.getReferenceOffers({ standardProductId: ids.pending, newcomer: true })).length, 0);
    assert.equal((await service.getReferenceOffers({ standardProductId: ids.account, newcomer: true }))[0]?.membershipKind, 'account');
    assert.equal((await service.getReferenceOffers({ standardProductId: ids.short_term, membershipKinds: ['short_term'], newcomer: true })).length, 1);
    assert.equal((await service.getReferenceOffers({ standardProductId: ids.youtube, newcomer: true })).length, 1);
  });

  test('one identity owns all feature groups, normal detail and history', async () => {
    const product = await service.getProduct(ids.base!);
    assert.ok(product);
    assert.equal('splitInto' in product, false);
    assert.equal('membershipKind' in product, false);
    const publicProduct = await new CatalogController(service).getProduct(ids.base!);
    assert.equal('splitInto' in publicProduct, false);
    assert.equal((await service.resolvePublicProductIdentity({ platform: 'openai', product: 'chatgpt', tier: 'plus' }))?.id, ids.base);
    assert.equal((await service.resolvePublicProductIdentities({ platform: 'openai', product: 'chatgpt', tier: 'plus' })).length, 1);
    const page = await service.getCatalog({ standardProductId: ids.base, detailKind: 'offers', detailPageSize: 10 });
    assert.equal(page.total, 1);
    const item = page.items[0]!;
    assert.equal(item.standardProductId, ids.base);
    assert.equal(item.detail?.total, 4);
    assert.equal(item.detail?.entries.length, 4);
    assert.deepEqual(item.membershipGroups?.map(group => group.kind), MEMBERSHIP_KINDS);
    for (const group of item.membershipGroups ?? []) {
      assert.equal(group.shopCount, 1);
      assert.equal(group.productCount, 1);
      assert.deepEqual(group.offers.map(offer => offer.productId), [products[group.kind]]);
    }
    const filtered = await repository.search(normalizeCatalogQuery({ standardProductId: ids.base,
      membershipKinds: ['account', 'top_up'], detailKind: 'shops', detailPageSize: 10 }));
    assert.equal(filtered.items[0]?.detail?.total, 1);
    const shop = filtered.items[0]?.detail?.entries[0];
    assert.ok(shop && 'count' in shop);
    assert.equal(shop.count, 2);
    const history = await service.getPriceHistory(ids.base!);
    assert.ok(history && !('splitInto' in history));
  });

  test('candidate change documents contain identity without feature classification', async () => {
    const version = await recordCandidateCatalogChanges(db, [BigInt(ids.account!), BigInt(ids.top_up!)], 'test-membership');
    const result = await sql<{ document: { membershipKind: string } }>`select document from catalog_index_changes
      where version = ${version.version} and operation = 'upsert'`.execute(db);
    assert.equal(result.rows.length, 1);
    assert.equal('membershipKind' in result.rows[0]!.document, false);
  });

  test('feature-only saves regroup existing offers without republishing or changing identity', async () => {
    const id = BigInt(products.account!);
    const original = await db.selectFrom('products').select('membership_features').where('id', '=', id).executeTakeFirstOrThrow();
    try {
      await saveFeature(products.account!, 'top_up');
      const page = await repository.search({ standardProductId: ids.base, tags: [], limit: 10 });
      assert.equal(page.total, 1);
      assert.equal(page.items[0]?.standardProductId, ids.base);
      assert.deepEqual(page.items[0]?.membershipGroups?.map(group => group.kind), ['top_up', 'rental', 'short_term']);
      const group = page.items[0]?.membershipGroups?.[0];
      assert.equal(group?.productCount, 2);
      assert.equal(group?.shopCount, 1);
      assert.equal(group?.offers[0]?.productId, products.account);
      const filtered = await repository.search({ standardProductId: ids.base, membershipKinds: ['account'], tags: [], limit: 10 });
      assert.equal(filtered.total, 0);
      assert.equal(filtered.offerTotal, 0);
      assert.equal((await repository.referenceOffers({ standardProductId: ids.base, membershipKinds: ['account'], tags: [], limit: 10 })).length, 0);
    } finally {
      await db.updateTable('products').set({ membership_features: jsonb(original.membership_features) }).where('id', '=', id).execute();
    }
  });

  test('unrecognized AI membership offers use short-term statistics without passing newcomer filtering or saving a classification', async () => {
    const id = BigInt(products.account!);
    const original = (await db.selectFrom('products').select('membership_features').where('id', '=', id).executeTakeFirstOrThrow()).membership_features as Record<string, JsonValue>;
    try {
      for (const snapshot of [null, {}, { ...original, contentVersion: '-1' }, { ...original, fingerprint: 'changed' },
        { ...original, revision: '99999' }, { ...original, policyVersion: 'old' },
        { ...original, decision: { kind: 'other', reason: 'llm_reviewed' } },
        { ...original, decision: { kind: 'account', reason: 'rule_derived' } },
        { ...original, source: { url: 'https://changed.invalid', protocol: null, platform: 'test' } }]) {
        await db.updateTable('products').set({ membership_features: snapshot === null ? null : jsonb(snapshot) }).where('id', '=', id).execute();
        const page = await repository.search({ standardProductId: ids.base, tags: [], limit: 10, detailKind: 'offers', detailPageSize: 10 });
        assert.equal(page.items[0]?.productCount, 4);
        const detail = page.items[0]?.detail;
        assert.ok(detail?.kind === 'offers');
        assert.equal(detail.entries.find(offer => offer.productId === products.account)?.membershipKind, 'short_term');
        assert.ok(!page.items[0]?.membershipGroups?.some(group => group.kind === 'account'));
        const shortTerm = page.items[0]?.membershipGroups?.find(group => group.kind === 'short_term');
        assert.equal(shortTerm?.productCount, 2);
        assert.equal(shortTerm?.shopCount, 1);
        assert.equal(Number(shortTerm?.minPrice), 1);
        assert.equal(Number(shortTerm?.maxPrice), 28);
        const filtered = await repository.search({ standardProductId: ids.base, membershipKinds: ['short_term'], tags: [], limit: 1,
          detailKind: 'offers', detailPageSize: 10 });
        assert.equal(filtered.offerTotal, 2);
        assert.equal(filtered.items[0]?.detail?.total, 2);
        assert.equal(Number(filtered.items[0]?.minPrice), 1);
        const stored = await db.selectFrom('products').select('membership_features').where('id', '=', id).executeTakeFirstOrThrow();
        assert.deepEqual(stored.membership_features, snapshot);
        const safe = await repository.search({ standardProductId: ids.base, newcomer: true, tags: [], limit: 10 });
        assert.equal(safe.items[0]?.productCount, 1);
        assert.deepEqual(safe.items[0]?.membershipGroups?.map(group => group.kind), ['top_up']);
        const reference = await repository.referenceOffers({ standardProductId: ids.base, newcomer: true, tags: [], limit: 10 });
        assert.deepEqual(reference.map(offer => offer.productId), [products.top_up]);
      }
    } finally {
      await db.updateTable('products').set({ membership_features: jsonb(original) }).where('id', '=', id).execute();
    }
    const pending = await repository.search({ standardProductId: ids.pending, tags: [], limit: 10 });
    assert.deepEqual(pending.items[0]?.membershipGroups?.map(group => group.kind), ['short_term']);
    assert.equal(pending.items[0]?.offers[0]?.membershipKind, 'short_term');
    assert.equal(pending.items[0]?.productCount, 1);
    await saveFeature(products.youtube!, 'account');
    const nonAi = await repository.search({ standardProductId: ids.youtube, tags: [], limit: 10 });
    assert.equal(nonAi.items[0]?.membershipGroups, undefined);
    assert.equal(nonAi.items[0]?.offers[0]?.membershipKind, null);
  });

  test('rental alias keeps dedicated access hard on AI while non-AI access values retain OR semantics', async () => {
    const shared = (await sql<{ id: string }>`insert into products (shop_id, external_id, name, spec, normalized_key, url)
      select shop_id, 'shared-rental', 'Shared rental', '', 'shared-rental', 'https://membership.invalid/shared-rental'
      from products where id = ${products.rental}::bigint returning id::text`.execute(db)).rows[0]!.id;
    await saveFeature(shared, 'rental');
    await sql`insert into standard_product_members (standard_product_id, product_id, publication_state, assignment_source)
      values (${ids.rental}::bigint, ${shared}::bigint, 'published', 'ai')`.execute(db);
    await sql`insert into product_tags (product_id, name, value) values (${shared}::bigint, 'access', 'shared')`.execute(db);
    await sql`insert into offers (product_id, idempotency_key, price, currency, captured_at, stock_available, is_stale)
      values (${shared}::bigint, 'shared-rental', 1, 'CNY', now(), true, false)`.execute(db);
    while (await publishNextCatalogChange(db)) {}
    const controller = new CatalogController(service);
    for (const q of ['ChatGPT Plus 租号（共享） 独享', 'ChatGPT Plus 租号(共享) 独享', 'ChatGPT Plus 合租 独享']) {
      const input = { q, newcomer: true };
      const query = normalizeCatalogQuery(input);
      const direct = await repository.search(query);
      const api = await controller.getCatalog({ q, newcomer: 'true' });
      for (const page of [direct, api]) {
        assert.equal(page.offerTotal, 1, q);
        assert.deepEqual(page.items.flatMap(item => item.offers.map(offer => offer.productId)), [products.rental], q);
      }
    }
    const sharedOnly = await repository.search(normalizeCatalogQuery({ q: 'ChatGPT Plus 共享' }));
    assert.equal(sharedOnly.offerTotal, 2, 'shared alias alone must still allow both rental access types');
    const nonAi = await controller.getCatalog({ q: 'youtube 共享 独享' });
    assert.deepEqual(nonAi.items.flatMap(item => item.offers.map(offer => offer.productId)), [products.youtube]);
    for (const q of ['ChatGPT Plus 没有共享', 'ChatGPT Plus 共享状态未知']) {
      assert.equal((await controller.getCatalog({ q })).total, 0, q);
    }
  });

  test('each feature gets four distinct merchant previews with full counts and standard pagination', async () => {
    for (let index = 0; index < 5; index++) {
      const shop = (await sql<{ id: string }>`insert into shops (name, platform, url)
        values (${`Group shop ${index}`}, 'test', ${`https://group${index}.invalid`}) returning id::text`.execute(db)).rows[0]!.id;
      for (const [key, kind, price] of [
        ['account', 'account', 10 + index], ['account-extra', 'account', 200 + index], ['top_up', 'top_up', 100 + index],
      ] as const) {
        const product = (await sql<{ id: string }>`insert into products (shop_id, external_id, name, spec, normalized_key, url)
          values (${shop}::bigint, ${key}, ${key}, '', ${`${index}/${key}`}, ${`https://group${index}.invalid/${key}`}) returning id::text`.execute(db)).rows[0]!.id;
        await saveFeature(product, kind);
        await sql`insert into standard_product_members (standard_product_id, product_id, publication_state, assignment_source)
          values (${ids.base}::bigint, ${product}::bigint, 'published', 'ai')`.execute(db);
        await sql`insert into offers (product_id, idempotency_key, price, currency, captured_at, stock_available, is_stale)
          values (${product}::bigint, ${`${index}/${key}`}, ${price}, 'CNY', now(), true, false)`.execute(db);
      }
    }
    while (await publishNextCatalogChange(db)) {}
    const page = await repository.search({ standardProductId: ids.base, tags: [], limit: 1 });
    assert.equal(page.total, 1);
    assert.equal(page.items.length, 1);
    assert.equal(page.nextCursor, undefined);
    const item = page.items[0]!;
    assert.equal(item.standardProductId, ids.base);
    assert.equal(item.shopCount, 6);
    assert.equal(item.productCount, 20);
    assert.equal(item.offers.length, 4);
    const account = item.membershipGroups?.find(group => group.kind === 'account')!;
    const topUp = item.membershipGroups?.find(group => group.kind === 'top_up')!;
    assert.equal(account.shopCount, 6);
    assert.equal(account.productCount, 11);
    assert.equal(Number(account.minPrice), 10);
    assert.equal(Number(account.maxPrice), 204);
    assert.ok(account.latestCapturedAt);
    assert.equal(topUp.shopCount, 6);
    assert.equal(topUp.productCount, 6);
    assert.equal(Number(topUp.minPrice), 50);
    assert.equal(Number(topUp.maxPrice), 104);
    for (const group of [account, topUp]) {
      assert.equal(group.offers.length, 4);
      assert.equal(new Set(group.offers.map(offer => offer.shopId)).size, 4);
      assert.ok(group.offers.every(offer => offer.membershipKind === group.kind && 'shopScore' in offer));
    }
    assert.deepEqual(account.offers.map(offer => offer.price), ['10.00', '11.00', '12.00', '13.00']);
    assert.deepEqual(topUp.offers.map(offer => offer.price), ['50.00', '100.00', '101.00', '102.00']);
    const capped = await repository.search({ standardProductId: ids.base, membershipKinds: ['account'], priceMax: '30', tags: [], limit: 1 });
    const cappedAccount = capped.items[0]?.membershipGroups?.[0];
    assert.equal(capped.offerTotal, 6);
    assert.equal(cappedAccount?.productCount, 6);
    assert.equal(Number(cappedAccount?.minPrice), 10);
    assert.equal(Number(cappedAccount?.maxPrice), 28);
    const filtered = await repository.search({ standardProductId: ids.base, membershipKinds: ['top_up'], tags: [], limit: 1,
      detailKind: 'offers', detailPage: 1, detailPageSize: 4 });
    assert.equal(filtered.offerTotal, 6);
    assert.equal(filtered.items[0]?.detail?.total, 6);
    assert.equal(filtered.items[0]?.detail?.entries.length, 2);
    assert.deepEqual(filtered.items[0]?.membershipGroups?.map(group => group.kind), ['top_up']);
  });

  test('HTTP feature scopes isolate offer and shop pages, prices, facets and cached reads for mixed merchants', async () => {
    const standard = await db.insertInto('standard_products').values({ name: 'Scoped Claude Pro', platform: 'anthropic',
      canonical_family: 'anthropic', canonical_product: 'claude', canonical_tier: 'pro', verification_state: 'verified',
    }).returning('id').executeTakeFirstOrThrow();
    const samples: Array<{ id: string; shopId: string; kind: MembershipKind; price: number; name: string; duration: string }> = [];
    for (let merchant = 0; merchant < 5; merchant++) {
      const shop = await db.insertInto('shops').values({ name: `Scoped merchant ${merchant}`, platform: 'test',
        url: `https://scoped${merchant}.invalid` }).returning('id').executeTakeFirstOrThrow();
      for (const [key, kind, price, duration] of [
        ['account', 'account', 100, '1 month'], ['account-extra', 'account', 300, '1 month'],
        ['top_up', 'top_up', 200, '2 months'], ['rental', 'rental', 10, '3 months'],
        ['short_term', 'short_term', 50, '4 months'], ['unknown', null, 1, '4 months'],
      ] as const) {
        const name = `Original merchant quote ${merchant}/${key}`;
        const source = await db.insertInto('products').values({ shop_id: shop.id, external_id: key, name,
          normalized_key: `${merchant}/${key}`, url: `https://scoped${merchant}.invalid/${key}`,
        }).returning('id').executeTakeFirstOrThrow();
        await db.insertInto('product_tags').values({ product_id: source.id, name: 'duration', value: duration }).execute();
        await db.insertInto('standard_product_members').values({ standard_product_id: standard.id,
          product_id: source.id, publication_state: 'published' }).execute();
        if (kind) await saveFeature(String(source.id), kind);
        await db.insertInto('offers').values({ product_id: source.id, idempotency_key: `scoped/${merchant}/${key}`,
          price: String(price + merchant), currency: 'CNY', captured_at: new Date(), stock_available: true, is_stale: false,
          settlement_price: String(price + merchant), settlement_verified_at: new Date(), settlement_payment_method: 'card',
        }).execute();
        samples.push({ id: String(source.id), shopId: String(shop.id), kind: kind ?? 'short_term', price: price + merchant, name, duration });
      }
    }
    while (await publishNextCatalogChange(db)) {}
    const module = await Test.createTestingModule({ controllers: [CatalogController],
      providers: [{ provide: CatalogService, useValue: service }] }).compile();
    const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const read = async (path: string, scope: Record<string, string | string[]>, status = 200) => {
      const params = new URLSearchParams({ standardProductId: String(standard.id) });
      for (const [key, value] of Object.entries(scope)) for (const entry of Array.isArray(value) ? value : [value]) params.append(key, entry);
      const response = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: `/v1/catalog${path}?${params}` });
      assert.equal(response.statusCode, status, response.body);
      return response.json();
    };
    const checkOffer = (offer: { productId: string; membershipKind: string; name: string; tags: Array<{ name: string; value: string }> }, expected: typeof samples) => {
      const source = expected.find(sample => sample.id === offer.productId);
      assert.ok(source, `out-of-scope quote ${offer.productId}`);
      assert.equal(offer.membershipKind, source.kind);
      assert.equal(offer.name, source.name, 'catalog must not append a membership label to the merchant name');
      assert.deepEqual(offer.tags.filter(tag => tag.value !== 'unknown').map(tag => ({ name: tag.name, value: tag.value })),
        [{ name: 'duration', value: source.duration }], 'features must not be appended to merchant tags');
    };
    try {
      for (const kind of [...MEMBERSHIP_KINDS, ...MEMBERSHIP_KINDS.toReversed()]) {
        const expected = samples.filter(sample => sample.kind === kind);
        const scope = { membershipKind: kind, newcomer: 'true' };
        const summary = await read('', scope);
        assert.equal(summary.total, 1);
        assert.equal(summary.offerTotal, expected.length);
        const item = summary.items[0];
        assert.equal(item.shopCount, 5);
        assert.equal(item.productCount, expected.length);
        assert.equal(Number(item.minPrice), Math.min(...expected.map(sample => sample.price)));
        assert.equal(item.offers.length, 4);
        assert.deepEqual(item.membershipGroups.map((group: { kind: string }) => group.kind), [kind]);
        const group = item.membershipGroups[0];
        assert.equal(Number(group.minPrice), Math.min(...expected.map(sample => sample.price)));
        assert.equal(Number(group.maxPrice), Math.max(...expected.map(sample => sample.price)));
        assert.equal(group.shopCount, 5);
        assert.equal(group.productCount, expected.length);
        for (const offer of [...item.offers, ...group.offers]) checkOffer(offer, expected);
        for (const detailKind of ['offers', 'shops']) {
          const seen: string[] = [];
          const total = detailKind === 'offers' ? expected.length : 5;
          for (let page = 0; page <= Math.ceil(total / 4); page++) {
            const result = await read('', { ...scope, detailKind, detailPage: String(page), detailPageSize: '4' });
            assert.equal(result.offerTotal, expected.length);
            assert.equal(result.items[0].detail.total, total);
            const entries = result.items[0].detail.entries;
            assert.equal(entries.length, Math.max(0, Math.min(4, total - page * 4)));
            for (const entry of entries) {
              const offer = detailKind === 'shops' ? entry.offer : entry;
              checkOffer(offer, expected);
              seen.push(detailKind === 'shops' ? entry.key : offer.productId);
              if (detailKind === 'shops') {
                const merchantQuotes = expected.filter(sample => sample.shopId === entry.key);
                assert.equal(entry.count, merchantQuotes.length);
                assert.equal(Number(offer.price), Math.min(...merchantQuotes.map(sample => sample.price)));
              }
            }
          }
          assert.equal(new Set(seen).size, total);
        }
        const facets = await read('/facets', scope);
        assert.deepEqual(facets.tagFacets.filter((tag: { name: string }) => tag.name === 'duration')
          .map((tag: { value: string; priority: number }) => [tag.value, tag.priority]), [[expected[0]!.duration, expected.length]]);
        const history = await read(`/products/${standard.id}/price-history`, scope);
        assert.equal(history.points.length, 1);
        assert.equal(Number(history.points[0].price), Math.min(...expected.map(sample => sample.price)));
        assert.ok(expected.some(sample => sample.id === history.points[0].productId));
        const other = samples.find(sample => sample.kind !== kind)!;
        assert.deepEqual((await read(`/products/${standard.id}/price-history`, { ...scope, productId: other.id })).points, []);
        const narrow = await read('', { ...scope, shopId: expected[0]!.shopId, priceMax: String(expected[0]!.price), detailKind: 'shops' });
        const narrowExpected = expected.filter(sample => sample.shopId === expected[0]!.shopId && sample.price <= expected[0]!.price);
        assert.equal(narrow.offerTotal, narrowExpected.length);
        assert.equal(narrow.items[0].detail.entries[0].count, narrowExpected.length);
        checkOffer(narrow.items[0].detail.entries[0].offer, narrowExpected);
      }
      const combined = await read('', { membershipKinds: ['account', 'top_up'], detailKind: 'shops', detailPageSize: '10' });
      assert.equal(combined.offerTotal, 15, 'plural HTTP membershipKinds must reach SQL instead of returning all 30 offers');
      assert.equal(combined.items[0].detail.total, 5);
      assert.ok(combined.items[0].detail.entries.every((entry: { count: number }) => entry.count === 3));
      assert.deepEqual(await read('', { membershipKind: ['account', 'top_up'], detailKind: 'shops', detailPageSize: '10' }), combined);
      const facets = await read('/facets', { membershipKinds: ['account', 'top_up'] });
      assert.deepEqual(facets.tagFacets.filter((tag: { name: string }) => tag.name === 'duration')
        .map((tag: { value: string }) => tag.value).sort(), ['1 month', '2 months']);
      for (const path of ['', '/facets', `/products/${standard.id}/price-history`]) {
        for (const scope of [{ membershipKind: 'account', membershipKinds: ['rental', 'short_term'] }, { membershipKinds: 'account' }]) {
          assert.equal((await read(path, scope, 400)).error.code, 'INVALID_MEMBERSHIP_KIND');
        }
      }
    } finally { await app.close(); }
  });
});
