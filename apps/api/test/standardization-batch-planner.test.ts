import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planBulkStandardizationBatches, planIndependentStandardizationBatches } from '../src/ai/standardization-batch-planner.js';

const limits = { maxItems: 32, maxInputBytes: 100000, maxInputTokens: 20000 };
const item = (id: number, name: string, endpoint?: string) => ({ productId: BigInt(id), payload: { name, spec: '', sourceData: endpoint ? { apiEndpoint: endpoint } : {} }, inputBytes: 150, estimatedTokens: 40 });
test('unrelated goods and distinct relay providers never share refusal failure boundaries', () => {
  const inputs = [item(1, '高中数学辅导课程'), item(2, 'Steam游戏充值卡'), item(3, '大模型API中转余额', 'https://alpha.example/v1'), item(4, '大模型API中转余额', 'https://beta.example/v1')];
  const batches = planIndependentStandardizationBatches(inputs, limits);
  assert.equal(batches.length, 4);
  assert.deepEqual(batches.flatMap(b => b.productIds).sort(), [1n, 2n, 3n, 4n]);
});
test('related inputs still batch together within the same service provider', () => {
  const batches = planIndependentStandardizationBatches([item(1, 'API中转余额 10', 'https://alpha.example/v1'), item(2, 'API中转余额 20', 'https://alpha.example/v1')], limits);
  assert.equal(batches.length, 1);
});
test('bulk planning keeps provider boundaries without fuzzy grouping', () => {
  const mixed = planBulkStandardizationBatches([
    { ...item(1, '高中数学辅导课程'), standardProductId: 1n }, { ...item(2, 'Steam游戏充值卡'), standardProductId: 2n },
    { ...item(3, 'API中转余额', 'https://alpha.example/v1'), standardProductId: 3n }, { ...item(4, 'API中转余额', 'https://beta.example/v1'), standardProductId: 3n },
  ], limits);
  assert.deepEqual(mixed.map(batch => batch.productIds), [[1n], [2n], [3n], [4n]]);
  const inputs = Array.from({ length: 1_001 }, (_, index) => ({ ...item(index + 1, `商品 ${index}`), standardProductId: 1n }));
  const batches = planBulkStandardizationBatches(inputs, { ...limits, maxItems: 100 });
  assert.equal(batches.length, 11);
  assert.equal(batches.reduce((count, batch) => count + batch.productIds.length, 0), 1_001);
});
test('bulk planning enforces byte and token budgets and excludes oversized inputs', () => {
  const inputs=Array.from({length:5},(_,index)=>({...item(index+1,'ChatGPT Plus'),standardProductId:1n}));
  const oversized={...inputs[0]!,productId:99n,inputBytes:301,estimatedTokens:201};
  for (const budget of [{...limits,maxInputBytes:300},{...limits,maxInputTokens:80}]) {
    const batches=planBulkStandardizationBatches([...inputs,oversized],budget);
    assert.deepEqual(batches.map(batch=>batch.productIds),[[1n,2n],[3n,4n],[5n]]);
  }
});
