import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReviewedTagExtractionDecision } from '../src/ai/tag-extraction-result.js';

for (const source of [
  '质保30天，需提供开箱视频',
  '质保30天，办理时带上订单截图',
  '质保30天。需提供开箱视频。',
  '质保30天。需先提供开箱视频',
  '质保30天。需要先提交订单截图',
  '质保30天。需自行准备订单截图',
  '质保30天。凭开箱视频申请。',
  '质保30天。必须提供开箱视频。',
  '需提供开箱视频，质保30天',
  '办理时带上订单截图，质保30天',
]) {
  test(`review approval owns prerequisite assessment: ${source}`, () => {
    const tag = { name: 'warranty', value: '质保30天', evidence: [] };
    const result = validateReviewedTagExtractionDecision(1n, [{ ...tag, proposalIndex: 0 }], [], { evidence: source }, [true]);
    assert.deepEqual(result.tags, [{ ...tag, proposalIndex: 0 }]);
    assert.deepEqual(result.rejectedTags, []);
    assert.deepEqual(result.reviewDecisions, [true]);
  });
}

for (const source of ['不享受质保', '质保已过期']) {
  test(`negative or expired warranty is not current coverage: ${source}`, () => {
    const tag = { name: 'warranty', value: source, evidence: [{ path: 'evidence', quote: source }] };
    const result = validateReviewedTagExtractionDecision(1n, [{ ...tag, proposalIndex: 0 }], [], { evidence: source }, [true]);
    assert.deepEqual(result.tags, []);
    assert.equal(result.rejectedTags.length, 1);
  });
}

for (const source of [
  '质保30天，需提供开箱视频',
  '质保30天，办理时带上订单截图',
  '质保30天。需提供开箱视频。',
  '质保30天。需先提供开箱视频',
  '质保30天。需要先提交订单截图',
  '质保30天。需自行准备订单截图',
  '质保30天。凭开箱视频申请。',
  '质保30天。必须提供开箱视频。',
  '需提供开箱视频，质保30天',
  '办理时带上订单截图，质保30天',
  '保订阅30天，封号不保',
  '仅保首登1小时，后续无售后',
]) {
  test(`complete warranty promise retains conditions and exclusions: ${source}`, () => {
    const tag = { name: 'warranty', value: source, proposalIndex: 0, evidence: [] };
    const result = validateReviewedTagExtractionDecision(1n, [tag], [], { evidence: source }, [true]);
    assert.deepEqual(result.tags, [tag]);
    assert.deepEqual(result.rejectedTags, []);
  });
}
