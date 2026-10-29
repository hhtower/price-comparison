import { createHash } from 'node:crypto';

export interface PublicationMember {
  readonly productId: bigint;
  readonly inputId: bigint;
  readonly tags: readonly unknown[];
  readonly payload: unknown;
}

export interface PublicationLimits {
  readonly maxMembers: number;
  readonly maxTagRows: number;
  readonly maxPayloadBytes: number;
  readonly maxSqlParameters: number;
}

export interface PublicationUnitPlan {
  readonly productIds: readonly bigint[];
  readonly memberCount: number;
  readonly tagCount: number;
  readonly payloadBytes: number;
  readonly sqlParameters: number;
}

export interface PublicationPlan {
  readonly units: readonly PublicationUnitPlan[];
  readonly oversizedProductIds: readonly bigint[];
  readonly planHash: string;
}

export const DEFAULT_PUBLICATION_LIMITS: PublicationLimits = {
  maxMembers: 100,
  maxTagRows: 5_000,
  maxPayloadBytes: 1_048_576,
  maxSqlParameters: 60_000,
};

const MEMBER_SQL_PARAMETERS = 6;
const TAG_SQL_PARAMETERS = 3;

export function planPublicationUnits(members: readonly PublicationMember[], limits: PublicationLimits = DEFAULT_PUBLICATION_LIMITS): PublicationPlan {
  validateLimits(limits);
  const ordered = [...members].sort((left, right) => left.productId < right.productId ? -1 : left.productId > right.productId ? 1 : 0);
  const duplicate = ordered.find((member, index) => index > 0 && member.productId === ordered[index - 1]!.productId);
  if (duplicate) throw new Error(`duplicate publication product ID: ${duplicate.productId}`);

  const units: PublicationUnitPlan[] = [];
  const oversizedProductIds: bigint[] = [];
  let pending: MutableUnit | undefined;
  const flush = () => {
    if (!pending) return;
    units.push({ ...pending, productIds: [...pending.productIds] });
    pending = undefined;
  };

  for (const member of ordered) {
    const metrics = memberMetrics(member);
    if (exceeds(metrics, limits)) {
      flush();
      oversizedProductIds.push(member.productId);
      continue;
    }
    if (pending && exceeds(addMetrics(pending, metrics), limits)) flush();
    pending = pending ? addMember(pending, member.productId, metrics) : {
      productIds: [member.productId], memberCount: 1, ...metrics,
    };
  }
  flush();

  const stable = {
    units: units.map(unit => ({ ...unit, productIds: unit.productIds.map(String) })),
    oversizedProductIds: oversizedProductIds.map(String),
  };
  return {
    units,
    oversizedProductIds,
    planHash: createHash('sha256').update(JSON.stringify(stable)).digest('hex'),
  };
}

type Metrics = { tagCount: number; payloadBytes: number; sqlParameters: number };
type MutableUnit = Metrics & { productIds: bigint[]; memberCount: number };

function memberMetrics(member: PublicationMember): Metrics {
  const payload = JSON.stringify(member.payload, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  return {
    tagCount: member.tags.length,
    payloadBytes: Buffer.byteLength(payload ?? 'null', 'utf8'),
    sqlParameters: MEMBER_SQL_PARAMETERS + member.tags.length * TAG_SQL_PARAMETERS,
  };
}

function addMetrics(left: Pick<MutableUnit, keyof Metrics | 'memberCount'>, right: Metrics): Metrics & { memberCount: number } {
  return {
    memberCount: left.memberCount + 1,
    tagCount: left.tagCount + right.tagCount,
    payloadBytes: left.payloadBytes + right.payloadBytes,
    sqlParameters: left.sqlParameters + right.sqlParameters,
  };
}

function addMember(unit: MutableUnit, productId: bigint, metrics: Metrics): MutableUnit {
  return { productIds: [...unit.productIds, productId], ...addMetrics(unit, metrics) };
}

function exceeds(metrics: Metrics & { memberCount?: number }, limits: PublicationLimits): boolean {
  return (metrics.memberCount ?? 1) > limits.maxMembers
    || metrics.tagCount > limits.maxTagRows
    || metrics.payloadBytes > limits.maxPayloadBytes
    || metrics.sqlParameters > limits.maxSqlParameters;
}

function validateLimits(limits: PublicationLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`publication limit ${name} must be a positive integer`);
  }
}
