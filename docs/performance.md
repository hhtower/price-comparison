# 性能说明

实际响应速度取决于数据量、数据库配置和并发负载。项目测试不代表对特定部署的吞吐量或响应时间承诺。

## 数据更新

- 报价和库存来自采集快照，抓取失败不会刷新采集时间；查看商品时仍需向商家核实。
- 目录存在短期缓存，数据修改后不一定立即可见。
- 评分、目录汇总和覆盖统计需要目录 worker 更新。数据迟迟不变时，应检查该进程及其日志；页面查询不会代替后台计算。

## 性能验证

在项目根目录运行以下工具，先确认目标数据库：

| 工具 | 用途与连接要求 |
| --- | --- |
| `npx tsx apps/api/scripts/benchmark-catalog.ts` | 目录请求基准；须设置指向专用本机 PostgreSQL 的 `TEST_DATABASE_URL`，工具会创建并清理测试数据 |
| `npx tsx apps/api/scripts/benchmark-catalog-sql.ts` | 只读检查目录查询；使用当前 `DATABASE_URL` 和 `PG_SCHEMA`，需要有代表性的数据 |

只读检查也会消耗数据库资源，应在合适的负载窗口运行。数据库执行时间不包含网络与页面渲染耗时，测试结果只适用于受测环境。

日常关注慢查询、锁等待、连接池等待、Redis 内存和浏览器请求耗时。配置建议见 [PostgreSQL](deployment/postgresql.md)和 [Redis](deployment/redis.md)；代码回归验证见 [开发与部署](../WORKFLOW.md)。
