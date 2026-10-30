import type { ColumnType, Generated } from 'kysely';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonbInput = string & { readonly __jsonbInput: unique symbol };
export type JsonbColumn = ColumnType<JsonValue, JsonbInput, JsonbInput>;
export type GeneratedJsonbColumn = ColumnType<
  JsonValue,
  JsonbInput | undefined,
  JsonbInput
>;
export type NullableJsonbColumn = ColumnType<JsonValue | null, JsonbInput | null | undefined, JsonbInput | null | undefined>;
export function jsonb(value: JsonValue): JsonbInput {
  return JSON.stringify(value) as JsonbInput;
}

export type FetchRunStatus = 'queued' | 'running' | 'succeeded' | 'deferred' | 'failed' | 'cancelled';
export type AiJobStatus = 'queued' | 'running' | 'paused' | 'ready' | 'ready_with_errors' | 'succeeded' | 'failed' | 'cancelled';
export type WorkItemStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type StandardizationMemberStatus = 'queued' | 'processing' | 'classified' | 'unclassified' | 'failed' | 'cancelled';
export type PublicationUnitStatus = 'queued' | 'running' | 'succeeded' | 'blocked' | 'failed' | 'cancelled';
export type StandardizationExecutionStatus = 'registered' | 'processing' | 'completed' | 'superseded' | 'cancelled';
export type StandardizationOutboxStatus = 'queued' | 'running' | 'succeeded' | 'deferred' | 'failed' | 'cancelled';
export type ProductChangeEventType = 'created' | 'evidence_changed' | 'restored';
export type ProductDeletionSource = 'manual' | 'linked' | 'crawler_missing' | 'legacy';
export type AiJobType = 'incremental' | 'calibration' | 'manual_full' | 'tag_extraction';
export type StandardVerificationState = 'provisional' | 'verified' | 'quarantined';
export type PublicationState = 'provisional' | 'published' | 'quarantined';

export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
export type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null,
  Date | string | null
>;

export interface ShopTable {
  id: Generated<bigint>;
  platform: string;
  protocol: Generated<string | null>;
  url: string;
  name: string;
  enabled: Generated<boolean>;
  last_fetch_at: NullableTimestamp;
  last_success_at: NullableTimestamp;
  next_fetch_at: GeneratedTimestamp;
  fetch_backoff_level: Generated<number>;
  scheduler_lease_until: NullableTimestamp;
  last_error: string | null;
  deleted_at: NullableTimestamp;
  shop_rating: NullableJsonbColumn;
  rating_manifest: NullableJsonbColumn;
}

export interface ProductTable {
  id: Generated<bigint>;
  shop_id: bigint;
  external_id: string;
  name: string;
  source_name: Generated<string>;
  source_description: Generated<string>;
  spec: Generated<string>;
  source_category: Generated<string>;
  source_data: GeneratedJsonbColumn;
  text_review: NullableJsonbColumn;
  text_review_key: ColumnType<string | null, never, never>;
  normalized_key: string;
  url: string;
  image_url: string | null;
  updated_at: GeneratedTimestamp;
  deleted_at: NullableTimestamp;
  deletion_source: Generated<ProductDeletionSource | null>;
  standardization_locked: Generated<boolean>;
  standardization_revision: Generated<bigint>;
  content_fingerprint: Generated<string>;
  content_version: Generated<bigint>;
  content_changed_at: GeneratedTimestamp;
}

export interface ProductPlatformTable { name: string; enabled: Generated<boolean> }

export interface StandardProductTable {
  aliases: Generated<string[]>;
  service_evidence: GeneratedJsonbColumn;
  hidden: Generated<boolean>;
  merged_into_id: bigint | null;
  id: Generated<bigint>;
  name: string;
  platform: Generated<string>;
  sort_order: Generated<bigint>;
  standard_key: string | null;
  canonical_platform: string | null;
  canonical_vendor: string | null;
  canonical_family: string | null;
  canonical_product: string | null;
  canonical_tier: string | null;
  verification_state: Generated<StandardVerificationState>;
  verification_run_id: bigint | null;
  verification_reason: NullableJsonbColumn;
  verification_updated_at: GeneratedTimestamp;
}

export interface StandardProductMemberTable {
  standard_product_id: bigint;
  product_id: bigint;
  created_at: GeneratedTimestamp;
  publication_state: Generated<PublicationState>;
  decision_version: Generated<bigint>;
  assignment_source: Generated<string>;
}

export type ManualStandardizationAction = 'assign' | 'unbind' | 'quarantine' | 'exclude' | 'merge' | 'identity_update';
export interface ProductStandardizationDecisionTable {
  id: Generated<bigint>;
  product_id: bigint;
  action: ManualStandardizationAction;
  standard_product_id: bigint | null;
  previous_standard_product_id: bigint | null;
  target_snapshot: NullableJsonbColumn;
  content_version: bigint | null;
  content_fingerprint: string | null;
  standardization_revision: bigint | null;
  evidence_known: boolean;
  evidence_snapshot: NullableJsonbColumn;
  reason: string;
  source: 'application' | 'direct_sql';
  created_at: GeneratedTimestamp;
}

export interface CatalogProductFactsTable {
  product_id: bigint;
  tags: JsonbColumn;
  tag_text: string;
  facet_tags: Generated<string>;
}

export interface CatalogReadOfferTable {
  product_id: bigint;
  standard_product_id: bigint;
  shop_id: bigint;
  product_name: string;
  product_url: string;
  product_spec: string;
  search_text: string;
  tags: JsonbColumn;
  facet_tags: string;
  warranty_days: ColumnType<number | null, never, never>;
  listed_price: string;
  currency: string;
  captured_at: Timestamp;
  is_stale: boolean;
  stock_available: boolean;
  available: ColumnType<boolean, never, never>;
  settlement_price: string | null;
  settlement_verified_at: NullableTimestamp;
  settlement_payment_method: string | null;
  settlement_quantity: number | null;
}

export interface CatalogReadOfferPricesTable extends Omit<CatalogReadOfferTable,
  'product_name' | 'product_url' | 'product_spec' | 'search_text' | 'tags' | 'facet_tags' | 'warranty_days'> {
  price: ColumnType<string, never, never>;
  verification_at: ColumnType<Date | null, never, never>;
}

export interface ProductTagTable {
  id: Generated<bigint>;
  product_id: bigint;
  name: string;
  value: string;
}

export interface OfferTable {
  id: Generated<bigint>;
  idempotency_key: string;
  product_id: bigint;
  price: string;
  currency: Generated<string>;
  captured_at: GeneratedTimestamp;
  is_stale: Generated<boolean>;
  stock_available: Generated<boolean>;
  settlement_price: string | null;
  settlement_verified_at: NullableTimestamp;
  settlement_payment_method: string | null;
  settlement_quantity: number | null;
  settlement_total_amount: string | null;
  settlement_refresh_at: NullableTimestamp;
}

export interface OfferPriceHistoryTable {
  id: Generated<bigint>;
  product_id: bigint;
  standard_product_id: bigint | null;
  content_version: bigint;
  name: string;
  spec: string;
  price: string;
  currency: string;
  quantity: number;
  payment_method: string;
  verified_at: Timestamp;
  recorded_at: GeneratedTimestamp;
}

export interface FetchRunTable {
  id: Generated<bigint>;
  shop_id: bigint;
  started_at: Timestamp;
  finished_at: NullableTimestamp;
  status: FetchRunStatus;
  item_count: Generated<bigint>;
  settlement_report: NullableJsonbColumn;
  task_type: Generated<'list' | 'settlement'>;
  settlement_payload: NullableJsonbColumn;
  source_fetch_run_id: bigint | null;
  crawl_metrics: NullableJsonbColumn;
  error: string | null;
  claimed_by: string | null;
  lease_until: NullableTimestamp;
  claim_token: string | null;
  attempts: Generated<bigint>;
  available_at: GeneratedTimestamp;
}

export interface AiJobTable {
  pipeline_versions: GeneratedJsonbColumn;
  id: Generated<bigint>;
  source_fetch_run_id: Generated<bigint | null>;
  retry_of_job_id: Generated<bigint | null>;
  retry_request_id: Generated<string | null>;
  parent_identity_job_id: Generated<bigint | null>;
  requested_scope: GeneratedJsonbColumn;
  status: AiJobStatus;
  total: bigint;
  processed: Generated<bigint>;
  applied: Generated<bigint>;
  model: string;
  auto_apply: Generated<boolean>;
  error: string | null;
  created_at: GeneratedTimestamp;
  finished_at: NullableTimestamp;
  scope_shop_id: bigint | null;
  prompt_version: Generated<string>;
  phase: Generated<string>;
  pause_requested: Generated<boolean>;
  cancel_requested: Generated<boolean>;
  failed_batches: Generated<bigint>;
  job_type: Generated<AiJobType>;
  trigger_event_id: bigint | null;
  priority: Generated<number>;
  input_bytes: Generated<bigint>;
  estimated_tokens: Generated<bigint>;
  classified: Generated<bigint>;
  unclassified: Generated<bigint>;
  rule_version: Generated<string>;
  request_window_size: Generated<number>;
  configuration_blocked: Generated<boolean>;
}

export interface AiJobInputTable {
  previous_decision: NullableJsonbColumn;
  manual_decision_id: Generated<bigint | null>;
  job_id: bigint;
  input_id: bigint;
  fingerprint: string;
  payload: JsonbColumn;
  status: WorkItemStatus;
  cached: Generated<boolean>;
  attempts: Generated<bigint>;
  error: string | null;
  input_bytes: Generated<bigint>;
  estimated_tokens: Generated<bigint>;
  available_at: GeneratedTimestamp;
  round: Generated<number>;
  content_version: Generated<bigint>;
  missing_reprocess_count: Generated<number>;
  reason_code: string | null;
}
export interface AiJobInputMemberTable {
  job_id: bigint;
  retry_source_job_id: Generated<bigint | null>;
  input_id: bigint;
  product_id: bigint;
  standardization_revision: Generated<bigint>;
  content_version: Generated<bigint>;
  fingerprint: Generated<string>;
  payload: GeneratedJsonbColumn;
  status: Generated<StandardizationMemberStatus>;
  missing_reprocess_count: Generated<number>;
  reason_code: string | null;
  output: NullableJsonbColumn;
}

export interface AiJobBatchTable {
  response_diagnostic: NullableJsonbColumn;
  request_estimate: NullableJsonbColumn;
  response_usage: NullableJsonbColumn;
  response_model: string | null;
  response_id: string | null;
  response_ms: number | null;
  id: Generated<bigint>;
  job_id: bigint;
  batch_index: bigint;
  product_ids: JsonbColumn;
  product_count: bigint;
  status: WorkItemStatus;
  attempts: Generated<bigint>;
  error: string | null;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  claimed_by: string | null;
  claim_token: string | null;
  lease_until: NullableTimestamp;
  available_at: GeneratedTimestamp;
  input_bytes: Generated<bigint>;
  estimated_tokens: Generated<bigint>;
  queued_at: GeneratedTimestamp;
  first_content_at: NullableTimestamp;
  response_completed_at: NullableTimestamp;
  retry_class: string | null;
  round: Generated<number>;
  step: Generated<'prepare' | 'request' | 'publish' | 'done'>;
  reference_snapshot: NullableJsonbColumn;
  reference_version: bigint | null;
  request_budget_limit: Generated<number>;
  request_budget_used: Generated<number>;
  confirmed_requests: Generated<number>;
  unknown_requests: Generated<number>;
  validated_decision: NullableJsonbColumn;
  decision_hash: string | null;
  publication_plan: NullableJsonbColumn;
  publication_cursor: Generated<number>;
  error_source: string | null;
  planned_at: NullableTimestamp;
  decision_saved_at: NullableTimestamp;
}

export interface AiPublicationUnitTable {
  id: Generated<bigint>;
  batch_id: bigint;
  unit_index: number;
  product_ids: JsonbColumn;
  member_count: number;
  tag_count: Generated<number>;
  payload_bytes: Generated<bigint>;
  status: Generated<PublicationUnitStatus>;
  error: string | null;
  claimed_by: string | null;
  claim_token: string | null;
  lease_until: NullableTimestamp;
  started_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
}

export interface AiBatchIdentityMappingTable {
  batch_id: bigint;
  identity_ref: string;
  canonical_key: string;
  identity_snapshot: JsonbColumn;
  standard_product_id: bigint | null;
  status: Generated<'pending' | 'resolved' | 'conflict'>;
  error: string | null;
  created_at: GeneratedTimestamp;
  resolved_at: NullableTimestamp;
}

export interface AiStandardizationExecutionTable {
  id: Generated<bigint>;
  product_id: bigint;
  content_version: bigint;
  fingerprint: string;
  snapshot: JsonbColumn;
  event_id: bigint | null;
  job_id: bigint;
  input_id: bigint;
  status: Generated<StandardizationExecutionStatus>;
  created_at: GeneratedTimestamp;
  completed_at: NullableTimestamp;
}

export interface AiStandardizationResultTable {
  job_id: bigint;
  product_id: bigint;
  batch_id: bigint | null;
  input_id: bigint;
  content_version: bigint;
  fingerprint: string;
  status: 'classified' | 'unclassified';
  standard_product_id: bigint | null;
  tags: GeneratedJsonbColumn;
  evidence: GeneratedJsonbColumn;
  reason_code: string | null;
  reason: string;
  decision: JsonbColumn;
  current_assignment_preserved: Generated<boolean>;
  published_at: NullableTimestamp;
  created_at: GeneratedTimestamp;
}

export interface ProductChangeEventTable {
  id: Generated<bigint>;
  source_fetch_run_id: Generated<bigint | null>;
  product_id: bigint;
  shop_id: bigint;
  content_version: bigint;
  fingerprint: string;
  event_type: ProductChangeEventType;
  payload: JsonbColumn;
  created_at: GeneratedTimestamp;
}

export interface StandardizationOutboxTable {
  id: Generated<bigint>;
  product_id: bigint;
  event_id: bigint;
  fingerprint: string;
  status: StandardizationOutboxStatus;
  attempts: Generated<bigint>;
  available_at: GeneratedTimestamp;
  claimed_by: string | null;
  lease_until: NullableTimestamp;
  claim_token: string | null;
  last_error: string | null;
  created_at: GeneratedTimestamp;
}

export interface AiJobProgressTable {
  job_id: bigint;
  version: Generated<bigint>;
  total: bigint;
  processed: Generated<bigint>;
  queued: Generated<bigint>;
  running: Generated<bigint>;
  succeeded: Generated<bigint>;
  failed: Generated<bigint>;
  updated_at: GeneratedTimestamp;
}

export interface CatalogCacheVersionTable {
  id: Generated<number>;
  version: bigint;
  updated_at: GeneratedTimestamp;
}
export interface StandardizationCatalogVersionTable {
  id: Generated<number>;
  version: bigint;
  alias_policy_version: string;
  updated_at: GeneratedTimestamp;
}
export interface CatalogIndexChangeTable {
  id: Generated<bigint>;
  version: bigint;
  standard_product_id: bigint;
  operation: 'upsert' | 'delete' | 'isolate';
  document: NullableJsonbColumn;
  created_at: GeneratedTimestamp;
}
export interface AdminTable {
  id: Generated<number>;
  password_hash: string;
}

export type ShopSubmissionStatus = 'pending' | 'approved' | 'rejected';

export interface ShopSubmissionTable {
  id: Generated<bigint>;
  platform: string;
  url: string;
  name: string;
  status: ShopSubmissionStatus;
  created_at: GeneratedTimestamp;
  reviewed_at: NullableTimestamp;
  reviewer: string | null;
  shop_id: bigint | null;
}

export type ProductReportReason = 'price_mismatch' | 'invalid_link' | 'misleading' | 'unsafe' | 'other';
export type ProductReportStatus = 'pending' | 'resolved' | 'dismissed';

export interface ProductReportTable {
  id: Generated<bigint>;
  product_id: bigint | null;
  product_name: string;
  shop_name: string;
  product_url: string;
  price: string;
  currency: string;
  price_captured_at: Date;
  reason: ProductReportReason;
  details: string;
  status: ProductReportStatus;
  created_at: GeneratedTimestamp;
  reviewed_at: NullableTimestamp;
  reviewer: string | null;
}

export interface DatabaseSchema {
  ai_tag_job_requests: {request_id:string;job_id:bigint};
  shops: ShopTable;
  products: ProductTable;
  product_platforms: ProductPlatformTable;
  standard_products: StandardProductTable;
  standard_product_members: StandardProductMemberTable;
  product_standardization_decisions: ProductStandardizationDecisionTable;
  product_tags: ProductTagTable;
  catalog_product_facts: CatalogProductFactsTable;
  catalog_read_offers: CatalogReadOfferTable;
  catalog_read_offer_prices: CatalogReadOfferPricesTable;
  catalog_read_facet_counts: { facet_tags: string; product_count: bigint };
  offers: OfferTable;
  offer_price_history: OfferPriceHistoryTable;
  fetch_runs: FetchRunTable;
  ai_jobs: AiJobTable;
  ai_job_inputs: AiJobInputTable;
  ai_job_input_members: AiJobInputMemberTable;
  ai_job_batches: AiJobBatchTable;
  ai_publication_units: AiPublicationUnitTable;
  ai_batch_identity_mappings: AiBatchIdentityMappingTable;
  ai_standardization_executions: AiStandardizationExecutionTable;
  ai_standardization_results: AiStandardizationResultTable;
  catalog_cache_versions: CatalogCacheVersionTable;
  admin: AdminTable;
  shop_submissions: ShopSubmissionTable;
  product_reports: ProductReportTable;
  product_change_events: ProductChangeEventTable;
  standardization_outbox: StandardizationOutboxTable;
  ai_job_progress: AiJobProgressTable;
  standardization_catalog_versions: StandardizationCatalogVersionTable;
  catalog_index_changes: CatalogIndexChangeTable;
}
