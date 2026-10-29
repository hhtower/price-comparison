import type { TagJobScope } from './tag-extraction-jobs.js';
import { Inject, Injectable } from '@nestjs/common';
import { DomainConflictError } from '../common/errors.js';
import { AiRepository, type CreateJobInput } from './ai.repository.js';
import { readAiStandardizationRuntimeStatus } from './ai-standardization-features.js';
@Injectable()
export class AiService {
  constructor(@Inject(AiRepository) private readonly repository: AiRepository) {}
  async createJob(input: CreateJobInput) {
    this.requireConfiguredRuntime();
    return this.repository.createJob(input);
  }
  private requireConfiguredRuntime() {
    const runtime = readAiStandardizationRuntimeStatus();
    if (!runtime.enabled) {
      throw new DomainConflictError(
        'AI_STANDARDIZATION_DISABLED',
        'AI 商品标准化功能未启用',
      );
    }
    if (!runtime.providerConfigured) {
      throw new DomainConflictError(
        'AI_CONFIGURATION_INCOMPLETE',
        runtime.configError,
      );
    }
    return runtime;
  }
  previewTagJob(input: TagJobScope) {
    const runtime=this.requireTagExtractionRuntime();
    return this.repository.previewTagJob({...input,model:runtime.model});
  }
  createTagJob(input: TagJobScope & {requestId:string;previewDigest?:string}) {
    const runtime=this.requireTagExtractionRuntime();
    return this.repository.createTagJob({...input,model:runtime.model});
  }
  private requireTagExtractionRuntime() {
    const runtime = this.requireConfiguredRuntime();
    if (!runtime.tagExtractionEnabled) {
      throw new DomainConflictError('AI_TAG_EXTRACTION_DISABLED', '标签抽取功能未启用');
    }
    return runtime;
  }
  retryPool(input: { requestId: string; productIds?: readonly bigint[] }) {
    const runtime = this.requireConfiguredRuntime();
    return this.repository.retryPool({ ...input, model: runtime.model });
  }
}
