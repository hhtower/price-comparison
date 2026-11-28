import { sql } from 'kysely';

// These historical constants must not follow the application policy.
export const membershipPolicy = sql.lit('ai-membership-20261110-v3');

// 79e69369: frozen SQL compiled from that revision's membership policy.
export const membershipKind037 = sql`case when "p".membership_features->>'contentVersion' = "p".content_version::text
  and "p".membership_features->>'fingerprint' = "p".content_fingerprint
  and "p".membership_features->>'revision' = "p".standardization_revision::text
  and "p".membership_features->>'policyVersion' = 'ai-membership-20261110-v3'
  and "p".membership_features #>> '{decision,reason}' = 'llm_reviewed'
  and "p".membership_features #>> '{decision,kind}' = any(array['account', 'top_up', 'rental', 'short_term']::text[]::text[])
  and (not ("p".membership_features ? 'source') or "p".membership_features->'source' = jsonb_build_object('url', "sh".url, 'protocol', "sh".protocol, 'platform', "sh".platform))
  then "p".membership_features #>> '{decision,kind}' else null end`;

// 20fac4ff: frozen SQL compiled from that revision's membership policy.
export const membershipKind052 = sql`case when "p".membership_features->>'contentVersion' = "p".content_version::text
  and "p".membership_features->>'fingerprint' = "p".content_fingerprint
  and "p".membership_features->>'revision' = "p".standardization_revision::text
  and "p".membership_features->>'policyVersion' = 'ai-membership-20261110-v3'
  and "p".membership_features #>> '{decision,reason}' = 'llm_reviewed'
  and "p".membership_features #>> '{decision,kind}' = any(array['account', 'top_up', 'top_up_half_price', 'rental', 'short_term']::text[]::text[])
  and ("p".membership_features #>> '{decision,kind}' not in ('top_up', 'top_up_half_price') or "p".membership_features->>'topUpPolicyVersion' = 'top-up-eligibility-20261124-v1')
  and (not ("p".membership_features ? 'source') or "p".membership_features->'source' = jsonb_build_object('url', "sh".url, 'protocol', "sh".protocol, 'platform', "sh".platform))
  then "p".membership_features #>> '{decision,kind}' else null end`;

// 99eac326: frozen SQL compiled from that revision's membership policy.
export const membershipKind054 = sql`case when "p".membership_features->>'contentVersion' = "p".content_version::text
  and "p".membership_features->>'fingerprint' = "p".content_fingerprint
  and "p".membership_features->>'revision' = "p".standardization_revision::text
  and "p".membership_features->>'policyVersion' = 'ai-membership-20261110-v3'
  and "p".membership_features #>> '{decision,reason}' = 'llm_reviewed'
  and "p".membership_features #>> '{decision,kind}' = any(array['account', 'top_up', 'top_up_half_price', 'rental', 'short_term']::text[]::text[])
  and (not ("p".membership_features #>> '{decision,kind}' = any(array['top_up', 'top_up_half_price']::text[]::text[])) or "p".membership_features->>'topUpPolicyVersion' = 'top-up-eligibility-20261124-v1')
  and "p".membership_features->'source' = jsonb_build_object('url', "sh".url, 'protocol', "sh".protocol, 'platform', "sh".platform)
  then "p".membership_features #>> '{decision,kind}' else null end`;

// 54e9fa0c: frozen SQL compiled from that revision's membership policy.
export const membershipKind055 = sql`case when "p".membership_features->>'contentVersion' = "p".content_version::text
  and "p".membership_features->>'fingerprint' = "p".content_fingerprint
  and "p".membership_features->>'revision' = "p".standardization_revision::text
  and "p".membership_features->>'policyVersion' = 'ai-membership-20261110-v3'
  and "p".membership_features #>> '{decision,reason}' = 'llm_reviewed'
  and "p".membership_features->'decision' = jsonb_build_object( 'kind', "p".membership_features #>> '{decision,kind}', 'reason', 'llm_reviewed')
  and "p".membership_features #>> '{decision,kind}' = any(array['account', 'top_up', 'top_up_half_price', 'rental', 'short_term']::text[]::text[])
  and (not ("p".membership_features #>> '{decision,kind}' = any(array['top_up', 'top_up_half_price']::text[]::text[])) or "p".membership_features->>'topUpPolicyVersion' = 'top-up-eligibility-20261124-v1')
  and "p".membership_features->'source' = jsonb_build_object('url', "sh".url, 'protocol', "sh".protocol, 'platform', "sh".platform)
  then "p".membership_features #>> '{decision,kind}' else null end`;
