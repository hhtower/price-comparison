# 性能边界与验证

本文说明交互请求和后台任务的工作量边界。回归测试验证请求数量、传输量、
失效条件和事务行为，不代表特定部署的吞吐量或响应时间承诺。

## 目录与店铺评分

- 目录保留最后一次成功采集的报价和库存，不因时间经过自动下架；明确售罄、
  停用、删除和取消发布仍生效。抓取失败不会刷新采集时间。
- 目录、筛选项和覆盖统计最多缓存五秒，相同请求合并读取。浏览器重返视图时重新校验；
  缓存上限不代表页面自动推送，也不包含查询和网络耗时。
- 评分、常用目录汇总与覆盖统计提前计算并持久化，输入变化后由目录 worker 原子更新；没有新数据时继续读取已有结果。
  查询不补算、不等待后台任务；搜索和组合筛选只查询已准备的报价与评分。

升级须先执行数据库迁移再启动新代码，见[开发与部署](../WORKFLOW.md)。
性能基准入口为 `apps/api/scripts/benchmark-catalog.ts`，需通过 `TEST_DATABASE_URL`
指定专用本机 PostgreSQL；脚本自动创建并清理测试 schema，分别测量冷请求、缓存复用和并发请求。


## 后台任务

- 写入 AI 进度只更新计数、版本并发送通知；完整统计由进度读取接口执行。
- 一次候选索引更新共用一份别名快照。目标没有别名时不传回全局别名；
  有别名时继续检查全局歧义及相关拥有者。
- 名称一致性修复先在只读事务中规划；没有变更时不取得维护表锁。
  有变更时，在原串行化事务中取得锁并重新规划，继续校验人工决定和内容版本。
  实际应用修复期间仍会阻塞相关写入，耗时取决于需要修复的数据量。

## 浏览器请求与静态资源

- 标准化队列已有请求尚未结束时，定时轮询跳过该轮；手动刷新仍可立即发起请求。
- 标签任务进度直接合并到页面；详情结果按一秒窗口合并刷新。同一详情视图中，
  在途刷新期间的新需求合并为后续补刷。终态、重连和手动刷新仍更新
  已加载分页及展开的依据；更新可见时间包含合并窗口和网络耗时。
- `/assets/*` 异步读取文件信息并以流发送内容，支持 ETag 和修改时间条件请求。
  带内容哈希的构建文件使用一年 `immutable` 缓存；其他文件必须重新验证。
  HTML 和业务接口不使用这项长期缓存策略。

## 回归验证入口

| 范围 | 测试文件 |
| --- | --- |
| 五秒缓存与取消过期重读 | `apps/api/test/catalog-cache.test.ts`、`apps/api/test/catalog.service-spec.ts` |
| 评分去重、后台发布及快照 | `apps/api/test/catalog.integration-spec.ts`、`apps/api/test/shop-text-review.test.ts` |
| 迁移升级及回滚 | `apps/api/test/database-bootstrap.integration-spec.ts` |
| 进度写入与别名查询 | `apps/api/test/ai-progress.test.ts`、`apps/api/test/catalog-aliases.repository.test.ts` |
| 名称一致性修复 | `apps/api/test/name-consensus-repair.test.ts`、`apps/api/test/name-consensus.integration-spec.ts` |
| 静态资源缓存与路径边界 | `apps/api/test/static-assets.test.ts` |
| 慢响应、连续推送及任务切换 | `apps/web/src/AiWorkbench.test.jsx`、`apps/web/src/TagExtractionPanel.test.jsx` |

运行方式和专用测试数据库要求见[开发与部署](../WORKFLOW.md)。数据库测试应使用
隔离实例或隔离 schema；不得用部署数据库替代测试连接。上线后的容量评估应另外
观察慢查询、数据库锁等待、连接池等待和浏览器请求耗时。
