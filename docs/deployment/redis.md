# Redis 运行配置

Redis 用于认证会话、目录缓存和分布式限流，不是业务事实来源。必须通过
`REDIS_URL` 配置 `redis://` 或 `rediss://` 地址；启用 TLS 时使用
`rediss://`。缓存不可用时目录回源 PostgreSQL，认证和限流依赖 Redis 的
原子操作并应视为不可用，而不是伪造成功状态。

## Key 与容量

- 认证 key 使用 `AUTH_SESSION_KEY_PREFIX` 隔离不同环境；
- 目录缓存使用短 TTL 和版本号失效；
- 限流 key 使用客户端地址、方法和路由，固定窗口由 Redis Lua 脚本原子递增；
- key、日志和监控标签不得包含密码、cookie、token、完整 URL 查询串或商品
  敏感内容；
- 按峰值连接数、key 数量和 value 大小设置 `maxmemory`，生产设置明确的
  eviction policy，并监控内存碎片和 rejected connections。

## 可用性与监控

Redis 应使用主从或托管高可用，并配置密码/TLS、网络 ACL 和备份策略。
监控 `connected_clients`、`blocked_clients`、`used_memory`、命中率、
命令延迟和 key eviction。应用指标 `redis_cache_hit_rate` 只表示目录缓存
读结果，不能当作业务数据完整性指标。

部署探针可以使用 Redis `PING`，但 API readiness 仍应以 PostgreSQL 和
应用自身状态为准。Redis 恢复后先验证认证会话、缓存读写和限流 Lua 脚本，
再恢复 worker 扩容。

## 关闭与恢复

应用收到 `SIGTERM` 后停止接收新请求，等待正在执行的请求和 worker 任务
完成或租约回收，再断开 Redis。缓存数据可删除后重建；认证会话删除会使
用户重新登录。恢复 Redis 时不要把旧缓存直接当作 PostgreSQL 的事实来源。
