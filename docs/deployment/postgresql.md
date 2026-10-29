# PostgreSQL 运行配置

应用只支持 PostgreSQL 16 或更高版本。生产连接应优先指向 PgBouncer
transaction pool，再由 PgBouncer 连接主库。每个 API 或 worker 实例的
`PG_POOL_MAX` 必须纳入数据库连接预算：

```text
实例数 * PG_POOL_MAX + 管理连接 + worker 连接 <= PostgreSQL max_connections
```

## PgBouncer

推荐使用 `pool_mode = transaction`，并把应用的 `DATABASE_URL` 指向
PgBouncer 服务。不要在业务代码中依赖 session 临时表、session 级
`SET` 或 prepared statement；schema 通过连接选项固定，事务级设置通过
SQL 显式声明。PgBouncer 的 `max_client_conn` 应覆盖 API 和 worker 的
并发连接上限，`default_pool_size` 则按主库预算设置。

应用连接参数：

- `PG_POOL_MAX`：单进程连接池上限；
- `PG_IDLE_TIMEOUT_MS`：空闲连接回收时间；
- `PG_CONNECTION_TIMEOUT_MS`：获取连接超时；
- `PG_STATEMENT_TIMEOUT_MS`：单条语句超时；
- `PG_SCHEMA`：可选的隔离 schema 名称。

## 慢查询与锁等待

将 `log_min_duration_statement` 设置为与 `SLOW_QUERY_THRESHOLD_MS`
一致或略高，默认应用阈值为 250ms。日志只记录 `queryName`、耗时和状态，
不记录 SQL 文本、绑定参数、密码、token 或连接 URL。使用
`pg_stat_activity` 观察 `wait_event_type = 'Lock'`，并按发布门槛持续检查
锁等待 P95 是否低于 50ms。

需要查询性能统计时启用 `pg_stat_statements`：

```sql
-- postgresql.conf
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
log_min_duration_statement = 250

-- 每个业务数据库执行一次
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

常用检查：

```sql
SELECT queryid, calls, total_exec_time, mean_exec_time,
       rows, shared_blks_hit, shared_blks_read
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;

SELECT pid, wait_event_type, wait_event, state, query_start
FROM pg_stat_activity
WHERE wait_event_type IS NOT NULL;
```

## 初始化与备份

首次安装对空数据库执行 `npm run db:migrate`，命令按文件名顺序自动执行
全部数据库脚本并记录状态，然后启动 API 和 worker，无需逐个执行脚本。
生产使用定期 `pg_dump` 或云数据库备份，并至少演练一次恢复到隔离实例。
