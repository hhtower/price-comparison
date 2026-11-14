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

for (const source of [
  '不享受质保', '质保已过期', '卡密一次性,不退不换',
  '到手1小时内无法正常使用可联系客服处理;超过1小时不售后;登录后封禁不退款不换号',
  '密码或2FA错误或绑定原始手机的情况有售后；账号被封禁无售后',
  '一个月内掉订阅但账号未封可按天售后;封号、秒封不保',
]) {
  test(`the recorded model vote alone decides text semantics: ${source}`, () => {
    const tag = { name: 'warranty', value: source, proposalIndex: 0, evidence: [] };
    const approved = validateReviewedTagExtractionDecision(1n, [tag], [], { evidence: source }, [true], true);
    assert.deepEqual(approved.tags, [tag]);
    assert.deepEqual(approved.rejectedTags, []);
    const rejected = { ...tag, reasonCode: 'review_rejected', reason: 'LLM 对该标签判定为否' };
    const refused = validateReviewedTagExtractionDecision(1n, [], [rejected], { evidence: source }, [false], true);
    assert.deepEqual(refused.tags, []);
    assert.deepEqual(refused.rejectedTags, [rejected]);
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
