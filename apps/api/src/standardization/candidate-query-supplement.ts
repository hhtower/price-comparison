import { buildCanonicalStandardKey } from './canonical-key.js';
import type { CandidateSearchQuery } from './candidate-index.js';

const OPENAI = /(?<![a-z])(?:open\s*ai|chat\s*gpt|gpt)(?![a-z])/u;
const CODEX = /(?<![a-z])codex(?![a-z])/u;
const OTHER_PLATFORM = /(?<![a-z])(?:claude|anthropic|cursor|google|gmail|outlook|hotmail|gemini)(?![a-z])/u;

/** At most one lookup hint; this neither admits a catalog entry nor confirms an alias. */
export function candidateQuerySupplement(query: CandidateSearchQuery): string | undefined {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase()
    .replace(/(?<![a-z])ghatcpt(?![a-z])/gu, 'chatgpt');
  const primary = normalize(query.primaryText ?? query.text);
  const text = normalize(query.text);
  const key = (family: string, product: string, tier: string) => buildCanonicalStandardKey({ family, product, tier });

  if (/(?<![a-z])outlook(?![a-z])/u.test(primary)
    && /接[码马]|收码|收件|验证码|inbox\s+code/iu.test(primary)
    && !/(?:不提供|不含|不支持|不是|非)[^,，。;；\n]{0,24}(?:接[码马]|收码|收件|验证码)/u.test(primary)
    && !/(?<!不)(?:支持|可以|可)(?:直接)?网页(?:端)?登录/u.test(text)
    && /邮箱|邮件|email|inbox/iu.test(text)) {
    return key('microsoft', 'mail_receive_service_mixed_domains', 'standard');
  }

  if ((OPENAI.test(primary) || CODEX.test(primary))
    && /(?<![a-z])free(?![a-z])|普通(?:账号|账户|帐号)/u.test(primary)
    && /无订阅|未订阅|未开通会员|不含订阅|no\s+subscription/u.test(text)
    && /成品号|账号|账户|帐号|account/u.test(primary)
    && !/(?:仅|只)(?:交付|出售|提供|售)[^,，。;；\n]{0,24}(?:邮箱|邮件)/u.test(text)) {
    return key('openai', 'chatgpt', 'free');
  }

  // Generic plan words require platform evidence; a different sales-title brand wins.
  if (!OPENAI.test(`${primary} ${text}`) || OTHER_PLATFORM.test(primary)) return undefined;
  const team = primary.match(/(?<![a-z])(?:team|business)(?=[^a-z]|$|x[\d.])/u);
  if (!team) return undefined;
  const before = primary.slice(0, team.index).match(/([\d.]+)\s*[x×倍]\s*$/u);
  const after = primary.slice(team.index! + team[0].length).match(/^\s*(?:([\d.]+)\s*[x×倍]|[x×]\s*([\d.]+))/u);
  const multipliers = new Set([before?.[1], after?.[1], after?.[2]].filter(value => value !== undefined));
  if (multipliers.size > 1 || [...multipliers].some(value => !['1', '5'].includes(value))) return undefined;
  const premium = /(?<![a-z])premium(?![a-z])/u.test(primary);
  return key('openai', 'chatgpt', premium || multipliers.has('5') ? 'team_5x' : 'team');
}
