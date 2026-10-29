import { Inject, Injectable } from '@nestjs/common';
import { DomainConflictError, DomainNotFoundError, DomainValidationError } from '../common/errors.js';
import { ShopsRepository } from '../shops/shops.repository.js';
import { ProtocolDetectionService, type ProtocolDetection } from '../platforms/protocol-detection.service.js';
import { ShopSubmissionsRepository, type ShopSubmission } from './shop-submissions.repository.js';

@Injectable()
export class ShopSubmissionsService {
  constructor(
    @Inject(ShopSubmissionsRepository) private readonly submissions: ShopSubmissionsRepository,
    @Inject(ShopsRepository) private readonly shops: ShopsRepository,
    @Inject(ProtocolDetectionService) private readonly protocols: ProtocolDetectionService,
  ) {}

  create(input: { platform?: string; url: string; name: string }): Promise<ShopSubmission> {
    const name = requiredText(input.name, 'name');
    const url = normalizeHttpUrl(input.url);
    const platform = input.platform?.trim() ?? '';
    return this.submissions.create({ name, url, platform }, this.shops);
  }

  listPending(page: number, pageSize: number): Promise<{ items: ShopSubmission[]; total: number }> {
    return this.submissions.listPending(page, pageSize);
  }

  listProtocols() { return this.protocols.list(); }

  async detect(id: bigint, protocol?: string): Promise<ProtocolDetection> {
    const submission = await this.submissions.findById(id);
    if (!submission) throw new DomainNotFoundError('SHOP_SUBMISSION_NOT_FOUND', '商铺提交不存在');
    if (submission.status !== 'pending') throw new DomainConflictError('SHOP_SUBMISSION_ALREADY_REVIEWED', '该商铺提交已审核');
    return this.protocols.detect(submission.url, protocol);
  }

  async review(id: bigint, action: 'approve' | 'reject', reviewer: string | null, protocol?: string): Promise<ShopSubmission> {
    const submission = await this.submissions.findById(id);
    if (!submission) throw new DomainNotFoundError('SHOP_SUBMISSION_NOT_FOUND', '商铺提交不存在');
    if (submission.status !== 'pending') throw new DomainConflictError('SHOP_SUBMISSION_ALREADY_REVIEWED', '该商铺提交已审核');
    if (action === 'reject') return this.submissions.review(id, 'rejected', reviewer, null);
    const verified = await this.protocols.requireMatch(submission.url, protocol);
    const approved = await this.submissions.approve(id, reviewer, (locked, transaction) => {
      if (locked.url !== submission.url) throw new DomainConflictError('SHOP_SUBMISSION_CHANGED', '商铺地址已改变，请重新探测');
      return this.shops.upsert({ platform: locked.platform, url: locked.url, name: locked.name, protocol: verified, enabled: true }, transaction);
    });
    try { await this.shops.enqueueRefresh([approved.shop_id!]); } catch { /* queueing is best effort; approval remains durable */ }
    return approved;
  }
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DomainValidationError('REQUIRED_FIELD', `${field} 不能为空`, { field });
  return normalized;
}

function normalizeHttpUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    return url.toString();
  } catch {
    throw new DomainValidationError('INVALID_URL', '商铺 URL 必须是有效的 HTTP(S) 地址');
  }
}
