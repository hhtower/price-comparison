import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.providers.js';
import { validateQualityReport } from './quality-report.js';
import type { QualityReport } from './quality.types.js';
export interface StoredQualityReport { report: QualityReport; accessHash: string; identityHash: string; }
export interface QualityReportStore {
  save(report: QualityReport, accessHash: string, identityHash: string, expiresAt: Date): Promise<void>;
  read(id: string): Promise<StoredQualityReport | null>;
}
@Injectable()
export class QualityRepository implements QualityReportStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async save(report: QualityReport, accessHash: string, identityHash: string, expiresAt: Date): Promise<void> {
    const complete = validateQualityReport(report);
    if (!['completed', 'cancelled', 'failed'].includes(complete.state) || !complete.completedAt || !/^[a-f0-9]{64}$/.test(accessHash) || !/^[a-f0-9]{64}$/.test(identityHash)) throw new Error('只允许保存完整终态报告');
    await this.pool.query('insert into quality_reports (id, access_hash, identity_hash, report, expires_at) values ($1, $2, $3, $4::jsonb, $5)', [complete.id, accessHash, identityHash, JSON.stringify(complete), expiresAt]);
  }
  async read(id: string): Promise<StoredQualityReport | null> {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const result = await this.pool.query<{ report: QualityReport; access_hash: string; identity_hash: string }>('select report, access_hash, identity_hash from quality_reports where id = $1 and expires_at > now()', [id]);
    const row = result.rows[0];
    return row ? { report: validateQualityReport(row.report), accessHash: row.access_hash, identityHash: row.identity_hash } : null;
  }
}
