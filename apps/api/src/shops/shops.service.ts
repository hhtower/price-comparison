import { Inject, Injectable } from '@nestjs/common';
import { DomainNotFoundError, DomainValidationError } from '../common/errors.js';
import { ProtocolDetectionService } from '../platforms/protocol-detection.service.js';
import {
  ShopsRepository,
  type QueuedFetchRun,
  type Shop,
  type ShopUpdate,
  type ShopUpsert,
} from './shops.repository.js';

@Injectable()
export class ShopsService {
  constructor(@Inject(ShopsRepository) private readonly shops: ShopsRepository,
    @Inject(ProtocolDetectionService) private readonly protocols: ProtocolDetectionService) {}

  async upsert(input: ShopUpsert): Promise<Shop> {
    const platform = requiredText(input.platform, 'platform');
    const name = requiredText(input.name, 'name');
    const url = normalizeHttpUrl(input.url);
    const protocol = input.protocol === undefined ? undefined : await this.protocols.requireMatch(input.url, input.protocol || undefined);
    return this.shops.upsert({
      ...input,
      ...(protocol === undefined ? {} : { protocol }),
      platform, name, url,
    });
  }

  async get(id: bigint): Promise<Shop> {
    const shop = await this.shops.findById(id);
    if (!shop) throw new DomainNotFoundError('SHOP_NOT_FOUND', '商铺不存在');
    return shop;
  }

  async update(id: bigint, input: ShopUpdate): Promise<Shop> {
    if (Object.keys(input).length === 0) {
      throw new DomainValidationError('EMPTY_UPDATE', '至少提供一个待修改字段');
    }
    const normalized: ShopUpdate = {
      ...(input.platform !== undefined ? { platform: requiredText(input.platform, 'platform') } : {}),
      ...(input.name !== undefined ? { name: requiredText(input.name, 'name') } : {}),
      ...(input.url !== undefined ? { url: normalizeHttpUrl(input.url) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
    let expectedSource: Pick<Shop, 'url' | 'protocol'> | undefined;
    if (input.protocol !== undefined || input.url !== undefined) {
      const current = await this.get(id);
      expectedSource = { url: current.url, protocol: current.protocol };
      if (input.protocol !== undefined || (current.protocol && normalized.url !== current.url)) {
        (normalized as { protocol?: string }).protocol = await this.protocols.requireMatch(normalized.url ?? current.url,
          input.protocol === undefined ? current.protocol ?? undefined : input.protocol || undefined);
      }
    }
    const shop = await this.shops.update(id, normalized, expectedSource);
    if (!shop) throw new DomainNotFoundError('SHOP_NOT_FOUND', '商铺不存在');
    return shop;
  }

  async remove(id: bigint): Promise<void> {
    if (!(await this.shops.softDelete(id))) {
      throw new DomainNotFoundError('SHOP_NOT_FOUND', '商铺不存在');
    }
  }

  async restore(id: bigint): Promise<Shop> {
    const shop = await this.shops.restore(id);
    if (!shop) throw new DomainNotFoundError('SHOP_NOT_FOUND', '商铺不存在或未删除');
    return shop;
  }

  enqueueRefresh(shopIds: readonly bigint[]): Promise<readonly QueuedFetchRun[]> {
    if (shopIds.length === 0) {
      throw new DomainValidationError('EMPTY_SHOP_IDS', '至少选择一个商铺');
    }
    if (new Set(shopIds).size !== shopIds.length) {
      throw new DomainValidationError('DUPLICATE_SHOP_IDS', '商铺 ID 不能重复');
    }
    return this.shops.enqueueRefresh(shopIds);
  }
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new DomainValidationError('REQUIRED_FIELD', `${field} 不能为空`, { field });
  }
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
