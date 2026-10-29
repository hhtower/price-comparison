# 标准商品重复审计报告

审计报告版本：`standard-product-duplicate-audit-20260921-v5`
审计策略：`duplicate-linkage-20260921-v3`
样本：`standard-product-pairs-20260921-v3`
质量门槛：`standard-product-duplicate-quality-gates-20260921-v4`

审计只读，不写数据库、不创建别名、不移动成员。门槛在读取 holdout 结果前固定；门槛版本和测量结果分开记录，不能根据保留集结果降低门槛。

重复标准商品采用分层记录链接：相同规范键和已确认别名进入确定性并查集；跨键相似只进入疑似对报告。BM25/token、字符 n-gram、tier 核心一致和 Fellegi-Sunter 分数均不能成为自动合并边，A-B 与 B-C 相似也不能推出 A-C。

development 与 holdout 分别构造目录、别名和审计索引，不产生跨分区候选 pair。策略权重只使用 development 校准，holdout 只用于冻结后的复核。fixture 显式记录人工 truth group，并在运行时拒绝同一组跨分区、match 跨组或 non-match 同组；同时校验字段结构、pair ID 唯一性和无序 pair key 唯一性，重复 pair 即使标签相同也拒绝，冲突标签单独报错。

| 分区 | 阻塞召回 | recall@K | 疑似对精度 | 硬冲突正确 | 实际核查 pair |
| --- | ---: | ---: | ---: | ---: | ---: |
| development | 4/4（100%） | 4/4（100%） | 2/2（100%） | 4/4（100%） | 2 |
| holdout | 30/30（100%） | 30/30（100%） | 10/10（100%） | 60/60（100%） | 10 |

| 指标 | Wilson 95% 区间 |
| --- | ---: |
| development 阻塞召回 / recall@K | 51.01%–100% |
| development 疑似对精度 | 34.24%–100% |
| development 硬冲突正确率 | 51.01%–100% |
| holdout 阻塞召回 / recall@K | 88.65%–100% |
| holdout 疑似对精度 | 72.25%–100% |
| holdout 硬冲突正确率 | 93.98%–100% |

| 冻结门槛 | 实际值 | 要求 | 状态 |
| --- | ---: | ---: | --- |
| development 阻塞召回 | 4/4（100%） | 100% | passed |
| development 疑似 pair recall@K | 4/4（100%） | ≥95% | passed |
| development 疑似对精度 | 2/2（100%） | ≥80% | passed |
| holdout 阻塞召回 | 30/30（100%） | 100% | passed |
| holdout 疑似 pair recall@K | 30/30（100%） | ≥95% | passed |
| holdout 疑似对精度 | 10/10（100%） | ≥80% | passed |
| 每千身份人工核查 pair | 12/193×1000（62.18） | ≤100 | passed |
| 硬冲突泄漏 | 0 | 0 | passed |
| 确定性误归并 | 0 | 0 | passed |
| 预算截断漏报 | 0 | 0 | passed |
| holdout match 样本 | 30 | ≥30 | passed |
| holdout non-match 样本 | 60 | ≥60 | passed |

冻结的目录重复质量门槛总状态为 `passed`。这表示固定 pair 上的记录链接回归门槛通过，不表示真实线上商品分布或模型语义质量已经得到证明。

完整审计包含 193 个分区内身份，实际比较 4,238 对，输出 12 个疑似 pair；平均每身份参与候选比较为 8,476/193（约 43.92）。确定性输出包含 22 个重复组和 24 条星形边，不枚举组内全部 pair。

| 召回路 | postings 访问 | 扫描上限 | 截断特征 | 固定路由顺序首次贡献 pair |
| --- | ---: | ---: | ---: | ---: |
| family/product | 263 | 7,720 | 0 | 87 |
| product/tier | 2,414 | 7,720 | 0 | 1,998 |
| 字符 n-gram | 3,714 | 7,720 | 0 | 1,566 |
| 合并 token | 2,938 | 7,720 | 0 | 587 |

逐路消融后，development 与 holdout 均没有新增漏报 pair；放宽 postings、比较数和 top-K 预算后也没有出现当前预算下被截断的 match pair。报告仍保留逐路漏报 pair ID 和预算截断漏报 pair ID 字段；任一预算截断漏报都会使总体状态变为 `blocked`。

`tierCoreExact` 只去除月付、年付、套餐和共享方式等非身份修饰。疑似阈值保持为 `3.5`；qualifier-only 差异不再同时受到核心一致正权重和完整 tier 不一致负权重。固定回归证明 `Basic` 与 `Basic Monthly` 可以进入疑似候选，而 `Basic Monthly` 与 `Premium Monthly` 去除共同修饰词后核心 tier 互斥，必须由 `tier_conflict` 判为 `distinct`。

每个身份的 top-K 先按疑似分数降序分配，同分再按稳定 pair key 排序，随后按 pair key 分页。cursor 绑定目录快照、别名版本、策略版本、逐路位置和最后 pair key；版本变化拒绝续页。质量门槛只计算完整结果，任一分区返回非空 `nextCursor` 时直接拒绝生成结论。固定测试会遍历到 `nextCursor=null`，验证全部分页无重复且与未分页结果完全一致，并覆盖增量结果等于全量结果中涉及 changed IDs 的子集，以及低分候选不得因 ID 排序挤掉高分候选。

holdout 中的 60 个 non-match 主要是固定 tier 硬冲突边界样本，适合回归但不能代表线上分布。真实模型响应和真实爬虫目录尚未用于本报告，因此生产模型语义质量继续标为 `unknown`；在取得真实样本前，不宣称语义重复已经全部消除。
