# 开发与部署

## 本地开发

按 [README](README.md)安装依赖、配置数据库与 Redis，并执行 `npm run db:migrate`。配置项见 [.env.example](.env.example)，不要将密钥或业务数据提交到仓库。

`npm run dev` 启动 API、前端和目录 worker，并按配置启动已启用的 AI 与官方参考价 worker。采集商品需另行运行 `npm run worker:crawler`。修改 `.env` 后重启进程。

## 可选能力

AI 功能默认关闭，启用后会调用配置的模型服务并可能产生费用，也会处理已有的排队任务。

- 商品标准化：配置模型服务并启用 `AI_STANDARDIZATION_ENABLED`。启用前准备已审核的标准商品目录；已有数据不会自动完成目录审核。
- AI 导购：配置模型服务、`ASSISTANT_MODEL`，并启用 `ASSISTANT_ENABLED`。单独调试可运行 `npm run worker:assistant`。
- Skill / MCP：由 API 提供，无需额外 worker，接入与邮件配置见 [Skill](docs/skill.md)和 [MCP](docs/mcp.md)。

## 验证

代码修改后运行受影响测试、`npm run typecheck` 和 `npm run build`；仅文档修改时核对内容与链接即可。`npm test` 包含后端和前端测试。

数据库与 Redis 集成测试只使用专用的 `TEST_DATABASE_URL`、`TEST_REDIS_URL` 或测试创建的临时容器，不使用业务连接。缺少测试服务时，部分测试会跳过或报错；容器测试需要 Docker。

LLM 测试使用 mock 或免费本地模型，不调用付费模型。开发约束见 [AGENTS.md](AGENTS.md)，贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 部署与升级

部署前配置 `.env`，确认数据库和 Redis 可访问，替换示例管理密码，并设置站点 HTTPS 地址。仅在可信反向代理覆盖转发头且 API 无法被绕过时启用 `TRUST_PROXY`。

升级前备份数据库并验证可恢复性，停止相关服务后执行迁移、构建并启动新版本。保留部署环境的 `.env`、数据库和持久化卷。迁移可能使旧标签、巡检结果或任务失效，升级前应核对影响，必要时在后台重新处理。

npm 部署升级时先清理旧 `dist/`，从项目根目录执行 `npm ci`、`npm run db:migrate`、`npm run build`，再运行 `npm start`。目录和采集任务需分别运行 `node dist/server/workers/catalog.worker.js` 与 `node dist/server/workers/crawler.worker.js`；其他 worker 的启动入口见 [package.json](package.json)。

使用外部数据库的 Docker 部署：

```bash
docker compose run --rm --build migrate
docker compose up -d --build
```

启用导购时，启动命令改为 `docker compose --profile assistant up -d --build`；npm 部署另行运行 `node dist/server/workers/assistant.worker.js`。API 与所有启用的 worker 必须使用同一版本，升级时同步重建，不能只重启旧容器。

启动后检查 `/health`、容器日志和所需任务是否正常处理。停用导购时，先关闭 `ASSISTANT_ENABLED` 并重启 API，再停止导购 worker。排查时不要记录密钥、会话凭证或对话正文。

数据库与缓存的配置、监控和备份建议见 [PostgreSQL](docs/deployment/postgresql.md)、[Redis](docs/deployment/redis.md)。报价展示和性能限制见 [性能说明](docs/performance.md)。
