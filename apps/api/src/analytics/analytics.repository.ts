import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.providers.js';
import { analyticsPeriod } from './analytics-input.js';
import type { AnalyticsCollection, AnalyticsQuery } from './analytics-contract.js';
import { AnalyticsNetworkService, type AnalyticsNetwork } from './analytics-network.js';

const networkFields = `host(ip) as ip, country_code as "countryCode", country, region, city, isp, geo_status as "geoStatus"`;

type AnalyticsVisit = AnalyticsNetwork & {
  id: string; visitorId: string; sessionId: string; page: AnalyticsCollection['page'];
  device: AnalyticsCollection['device']; browser: AnalyticsCollection['browser']; source: AnalyticsCollection['source'];
  activeMs: number; startedAt: string; lastSeenAt: string; actions: number; geoFromCache: boolean;
};

// Filter reports, not stored events, so historical data follows the same rule.
const reportableIp = `not exists (
  select 1 from analytics_excluded_ips e
  where v.ip = e.ip or v.ip = case when family(e.ip) = 4 then ('::ffff:' || host(e.ip))::inet else e.ip end
)`;

// Preserve original snapshots; annotate the current cache supplement separately.
const enrichedVisits = `select v.id, v.visitor_id, v.session_id, v.page, v.device, v.browser, v.source, v.ip,
  v.active_ms, v.started_at, v.last_seen_at,
  coalesce(v.country_code, c."countryCode") as country_code, coalesce(v.country, c.country) as country,
  coalesce(v.region, c.region) as region, coalesce(v.city, c.city) as city, coalesce(v.isp, c.isp) as isp,
  case when c.ip is not null then 'resolved' else v.geo_status end as geo_status, c.ip is not null as geo_from_cache
  from analytics_visits v left join jsonb_to_recordset($3::jsonb)
    as c(ip inet, "countryCode" text, country text, region text, city text, isp text)
    on c.ip = v.ip and v.geo_status in ('unknown', 'unavailable')
  where v.started_at >= $1::timestamptz and v.started_at < $2::timestamptz and ${reportableIp}`;

// Expressions are fixed below, never user input. Keep the nine largest buckets and
// combine the remainder so chart percentages still use every visit.
function geographicDistribution(expression: string): string {
  return `(select coalesce(jsonb_agg(jsonb_build_object('key', bucket.key, 'count', bucket.count) order by bucket.other, bucket.count desc, bucket.key), '[]'::jsonb) from (
    select case when rn > 9 then '其他' else key end as key, sum(count)::integer as count, bool_or(rn > 9) as other from (
      select groups.*, row_number() over (order by count desc, key) as rn from (
        select ${expression} as key, count(*)::integer as count from visits group by 1
      ) groups
    ) ranked group by 1
  ) bucket)`;
}

@Injectable()
export class AnalyticsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(AnalyticsNetworkService) private readonly network?: AnalyticsNetworkService) {}

  async excludedIps(): Promise<string[]> {
    const result = await this.pool.query('select host(ip) as ip from analytics_excluded_ips order by ip');
    return result.rows.map(row => row.ip);
  }

  async addExcludedIp(ip: string): Promise<void> {
    await this.pool.query('insert into analytics_excluded_ips (ip) values ($1::inet) on conflict (ip) do nothing', [ip]);
  }

  async removeExcludedIp(ip: string): Promise<void> {
    await this.pool.query('delete from analytics_excluded_ips where ip = $1::inet', [ip]);
  }

  private async cachedNetworks(start: string, end: string): Promise<AnalyticsNetwork[]> {
    if (!this.network) return [];
    const result = await this.pool.query(`select distinct host(ip) as ip from analytics_visits v
      where started_at >= $1::timestamptz and started_at < $2::timestamptz
        and ip is not null and geo_status in ('unknown', 'unavailable') and ${reportableIp}`, [start, end]);
    return this.network.cached(result.rows.map(row => row.ip));
  }

  async visitNetwork(input: AnalyticsCollection): Promise<AnalyticsNetwork | undefined> {
    const result = await this.pool.query(`select ${networkFields} from analytics_visits
      where id = $1 and visitor_id = $2 and session_id = $3 and page = $4`, [input.visitId, input.visitorId, input.sessionId, input.page]);
    return result.rows[0];
  }

  async collect(input: AnalyticsCollection, network?: AnalyticsNetwork): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // Identity/page/network snapshot are immutable. Overlapping requests cannot decrease duration or
      // add the same action twice. Duration cannot exceed elapsed server time.
      const accepted = await client.query(`insert into analytics_visits (id, visitor_id, session_id, page, device, browser, source, ip, country_code, country, region, city, isp, geo_status)
        values ($1,$2,$3,$4,$5,$6,$7,$9::inet,$10,$11,$12,$13,$14,$15) on conflict (id) do update set
        active_ms = greatest(analytics_visits.active_ms, least($8::integer, greatest(0, floor(extract(epoch from (clock_timestamp() - analytics_visits.started_at)) * 1000))::bigint)),
        last_seen_at = greatest(analytics_visits.last_seen_at, clock_timestamp())
        where analytics_visits.visitor_id = excluded.visitor_id and analytics_visits.session_id = excluded.session_id and analytics_visits.page = excluded.page
        returning id`, [input.visitId, input.visitorId, input.sessionId, input.page, input.device, input.browser, input.source, input.activeMs,
        network?.ip ?? null, network?.countryCode ?? null, network?.country ?? null, network?.region ?? null, network?.city ?? null, network?.isp ?? null, network?.geoStatus ?? 'unknown']);
      if (accepted.rows.length && input.actions.length) {
        await client.query(`insert into analytics_actions (id, visit_id, name, reference_app_id, reference_plan_id)
          select action.id::uuid, $1::uuid, action.name, action.reference->>'appId', action.reference->>'planId'
          from jsonb_to_recordset($2::jsonb) as action(id text, name text, reference jsonb)
          on conflict (id) do nothing`, [input.visitId, JSON.stringify(input.actions)]);
      }
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async summary(query: AnalyticsQuery) {
    const period = analyticsPeriod(query.days);
    const result = await this.pool.query(`with visits as materialized (${enrichedVisits}), actions as materialized (
        select a.*, v.visitor_id from analytics_actions a join analytics_visits v on v.id = a.visit_id
        where a.created_at >= $1::timestamptz and a.created_at < $2::timestamptz and ${reportableIp}
      ), visit_usage as (
        select visitor_id, count(*)::integer as page_views, sum(active_ms)::double precision as active_ms, max(last_seen_at) as last_seen_at
        from visits group by visitor_id
      ), action_usage as (
        select visitor_id, count(*)::integer as actions, max(created_at) as last_seen_at from actions group by visitor_id
      ), daily as (
        select (started_at at time zone 'Asia/Shanghai')::date as day, count(*)::integer as pv, count(distinct visitor_id)::integer as uv, count(distinct session_id)::integer as sessions
        from visits group by 1
      ), days as (select generate_series(($1::timestamptz at time zone 'Asia/Shanghai')::date, ($2::timestamptz at time zone 'Asia/Shanghai')::date - 1, interval '1 day')::date as day)
      select jsonb_build_object(
        'overview', (select jsonb_build_object('pageViews', count(*)::integer, 'visitors', count(distinct visitor_id)::integer, 'sessions', count(distinct session_id)::integer, 'avgActiveMs', coalesce(round(avg(active_ms)),0)::integer, 'actions', (select count(*)::integer from actions)) from visits),
        'trend', (select coalesce(jsonb_agg(jsonb_build_object('date', to_char(days.day,'YYYY-MM-DD'), 'pageViews', coalesce(daily.pv,0), 'visitors', coalesce(daily.uv,0), 'sessions', coalesce(daily.sessions,0)) order by days.day), '[]'::jsonb) from days left join daily using(day)),
        'pages', (select coalesce(jsonb_agg(row order by row.count desc, row.key), '[]'::jsonb) from (select page as key, count(*)::integer as count, count(distinct visitor_id)::integer as visitors, coalesce(round(avg(active_ms)),0)::integer as "avgActiveMs" from visits group by page) row),
        'devices', (select coalesce(jsonb_agg(row order by row.count desc, row.key), '[]'::jsonb) from (select device as key, count(*)::integer as count from visits group by device) row),
        'browsers', (select coalesce(jsonb_agg(row order by row.count desc, row.key), '[]'::jsonb) from (select browser as key, count(*)::integer as count from visits group by browser) row),
        'sources', (select coalesce(jsonb_agg(row order by row.count desc, row.key), '[]'::jsonb) from (select source as key, count(*)::integer as count from visits group by source) row),
        'countries', ${geographicDistribution("coalesce(country, '未知')")},
        'regions', ${geographicDistribution("case when region is null then '未知' else concat_ws(' / ', country, region) end")},
        'cities', ${geographicDistribution("case when city is null then '未知' else concat_ws(' / ', country, region, city) end")},
        'isps', ${geographicDistribution("coalesce(isp, '未知')")},
        'actions', (select coalesce(jsonb_agg(row order by row.count desc, row.key), '[]'::jsonb) from (select name as key, count(*)::integer as count, count(distinct visitor_id)::integer as visitors from actions group by name) row),
        'visitorRanking', (select coalesce(jsonb_agg(row order by row.actions desc, row."pageViews" desc, row."activeMs" desc, row."visitorId"), '[]'::jsonb) from (
          select visitor_id as "visitorId", coalesce(v.page_views, 0) as "pageViews", coalesce(a.actions, 0) as actions,
            coalesce(v.active_ms, 0) as "activeMs", greatest(v.last_seen_at, a.last_seen_at) as "lastSeenAt"
          from visit_usage v full join action_usage a using (visitor_id)
          order by actions desc, "pageViews" desc, "activeMs" desc, "visitorId" limit 20
        ) row),
        'reference', jsonb_build_object(
          'opens', (select count(*)::integer from actions where name = 'reference_open'),
          'visitors', (select count(distinct visitor_id)::integer from actions where name = 'reference_open'),
          'products', (select coalesce(jsonb_agg(row order by row.count desc, row.key), '[]'::jsonb) from (
            select reference_app_id as key, count(*)::integer as count, count(distinct visitor_id)::integer as visitors
            from actions where name = 'reference_product' group by reference_app_id
          ) row),
          'plans', (select coalesce(jsonb_agg(row order by row.count desc, row."appId", row."planId"), '[]'::jsonb) from (
            select reference_app_id as "appId", reference_plan_id as "planId", count(*)::integer as count, count(distinct visitor_id)::integer as visitors
            from actions where name = 'reference_plan_select' group by reference_app_id, reference_plan_id
            order by count desc, reference_app_id, reference_plan_id limit 20
          ) row)
        )
      ) as data`, [period.start, period.end, JSON.stringify(await this.cachedNetworks(period.start, period.end))]);
    return { ...result.rows[0].data, period };
  }

  async visits(query: AnalyticsQuery) {
    const period = analyticsPeriod(query.days);
    const result = await this.pool.query<{ data: { total: number; items: AnalyticsVisit[] } }>(`with page as materialized (
        select v.* from analytics_visits v
        where v.started_at >= $1::timestamptz and v.started_at < $2::timestamptz and ${reportableIp}
        order by v.started_at desc, v.id desc limit $3 offset $4
      )
      select jsonb_build_object('total', (select count(*)::integer from analytics_visits v
        where v.started_at >= $1::timestamptz and v.started_at < $2::timestamptz and ${reportableIp}),
        'items', (select coalesce(jsonb_agg(row order by row."startedAt" desc, row.id desc), '[]'::jsonb) from (
        select v.id, v.visitor_id as "visitorId", v.session_id as "sessionId", v.page, v.device, v.browser, v.source, v.active_ms as "activeMs", v.started_at as "startedAt", v.last_seen_at as "lastSeenAt",
        host(v.ip) as ip, v.country_code as "countryCode", v.country, v.region, v.city, v.isp, v.geo_status as "geoStatus", false as "geoFromCache",
        (select count(*)::integer from analytics_actions a where a.visit_id = v.id and a.created_at < $2::timestamptz) as actions
        from page v
      ) row)) as data`, [period.start, period.end, query.limit, (query.page - 1) * query.limit]);
    const data = result.rows[0].data;
    const addresses = [...new Set(data.items.flatMap(visit =>
      visit.ip && (visit.geoStatus === 'unknown' || visit.geoStatus === 'unavailable') ? [visit.ip] : []))];
    const cached = new Map((this.network && addresses.length ? await this.network.cached(addresses) : []).map(network => [network.ip, network]));
    const items = data.items.map(visit => {
      const supplement = visit.geoStatus === 'unknown' || visit.geoStatus === 'unavailable' ? cached.get(visit.ip) : undefined;
      if (!supplement) return visit;
      return { ...visit, countryCode: visit.countryCode ?? supplement.countryCode, country: visit.country ?? supplement.country,
        region: visit.region ?? supplement.region, city: visit.city ?? supplement.city, isp: visit.isp ?? supplement.isp,
        geoStatus: 'resolved' as const, geoFromCache: true };
    });
    return { ...data, items, page: query.page, pageSize: query.limit, period };
  }
}
