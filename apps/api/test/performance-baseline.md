# 标准化性能回归基线

本地基线分成两类证据：任何环境都执行结构性上限；只有环境指纹匹配时才执行数值预算。数据库事务、锁等待和执行计划必须在设置 `TEST_DATABASE_URL` 的隔离 PostgreSQL 中另行采集，stub 的零值只表示未测量。

现有目录/API 发布阈值继续保留：缓存命中 P95 < 100ms，缓存未命中 P95 < 300ms，管理列表 P95 < 500ms，AI 写入入口 P95 < 500ms，错误率 < 1%。这些阈值由 k6 场景检查，不替代下述标准化结构预算。

## 本地结构检查

```text
node --import tsx --test apps/api/test/performance-standardization.spec.ts
node --import tsx apps/api/perf/standardization-baseline.ts --check
```

固定种子为 `20260920`。1k/5k/10k 场景中的原始商品数 `N`、唯一证据数 `U` 和目录身份数 `D` 同时增长；报告记录证据字节、tags 行数、逻辑批次数、目录审计比较数和模型请求数。硬门槛如下：

- 单批最多 32 项和 24,576 bytes。
- 目录审计每个身份最多比较 100 对，不允许构造 `D×D` 矩阵。
- 高频阻塞特征在遍历 postings 时按 256 截断，不先物化全部 pair。
- 疑似对每身份最多保留 10 个，全局单页最多 10,000 个。
- 本地基线不得创建 OpenAI client 或发送 provider 请求。

机器可读预算位于 `apps/api/perf/standardization-performance-budget.json`。环境指纹不一致时，数值检查必须失败并要求在目标部署资源上重建基线，不能拿不同机器的耗时直接计算回归比例。

## 数据库性能检查

设置 `TEST_DATABASE_URL` 后，在独立 schema 中运行迁移和集成测试，采集候选精确查询、滚动窗口领取、发布单元提交和统一收尾的执行计划，以及 SQL P95、事务时长、锁等待、写入量和吞吐。

没有 `TEST_DATABASE_URL` 时，这些数值必须标记“未执行”，不得把 stub 的 `sqlP95Ms=0`、`lockWaitMs=0` 或 `publicationMs=0` 写成通过证据。

现有百万商品目录/API 工具仍可运行 `npm run perf:fixtures`、`npm run perf:explain`、`npm run perf:catalog` 和 `npm run perf:ai`，但不能替代标准化发布与锁竞争测试。
