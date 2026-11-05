# 开发与部署流程

## 本地开发

按 [README](README.md)安装依赖、配置 PostgreSQL/Redis 并初始化数据库。`npm run dev`统一启动 API 和前端；AI worker 是否启动由环境开关及模型配置决定。不要将实际密钥写入源码、测试或提交记录。

首次安装时，对新建的空数据库执行一次 `npm run db:migrate`，命令自动按顺序建立完整数据库结构并记录执行状态，无需手动选择或逐个执行脚本。API、crawler 和各 worker 共用该数据库，初始化完成后再启动进程；各进程需使用一致的配置及代码版本。

可选能力按 [.env.example](.env.example)配置，默认不启用模型调用。标准化使用 `AI_STANDARDIZATION_ENABLED`，导购使用 `ASSISTANT_ENABLED` 和 `ASSISTANT_MODEL`，共用现有服务商和代理；导购独立执行，不占用共享 `AI_CONCURRENCY`，不设模型并发上限。`npm run dev`会启动已启用能力所需的 worker；单独调试导购可运行 `npm run worker:assistant`。

MCP 服务的账号申请、邮件配置与客户端接入见 [MCP 报价服务](docs/mcp.md)，无需额外 worker。

## 版本迭代

版本采用 `年.月.当月发布序号`，月份和序号不补零，每月序号从 1 开始。每个版本迭代开始前，先统一更新根项目、各工作区包及锁文件中的版本号，后续功能开发沿用该迭代版本。

## 验证

运行 `npm run typecheck`、`npm run build`及受影响测试。`npm test`包含 Node 测试与 Vitest 前端测试；集成测试仅使用专用的 `TEST_DATABASE_URL`、`TEST_REDIS_URL`，或测试自动创建的 Docker 临时容器，不回退使用部署连接。未提供测试连接时，部分测试会跳过或提示缺少配置；使用临时容器的测试需要 Docker。

LLM 开发约束见 [AGENTS.md](AGENTS.md#llm-调用不变量)。相关测试使用 mock 或免费本地模型；真实模型效果需单独评测，付费调用须另行授权。导购资料的更新要求和推荐边界见 [导购能力资料](docs/assistant-capabilities.md)。

## 生产部署

目录评分、常用汇总与覆盖统计由 `worker:catalog` 在数据变化后更新；开发启动及 Compose 已包含该进程。
首次升级时后台补齐已有数据，未准备好的汇总暂不展示；查询不等待或触发补算。

服务器使用本仓库的源码与目录结构。npm 部署从项目根目录安装依赖并重新构建；Docker 部署从项目根目录构建镜像，容器内运行编译产物。

更新部署前备份业务数据库，停止相关进程后清除旧 `dist/`，再执行 `npm ci`、`npm run db:migrate` 和 `npm run build`，完成后启动 API 与所需 worker。Docker 部署重新构建镜像并重建容器。保留部署环境的 `.env`、业务数据库和持久化卷，不用源码覆盖它们。

`docker-compose.yml`提供 API 与独立 worker 的示例，数据库与 Redis 由部署者提供。先创建 `.env`，配置容器可访问的数据库地址、强管理密码、站点 HTTPS origin 及所需 worker 开关。设置反向代理时，应仅在代理覆盖转发头且 API 不可被绕过时启用 `TRUST_PROXY`。

编译部署按需运行 `dist/server/workers/` 下的对应入口，例如 `node dist/server/workers/assistant.worker.js`。Compose 中导购 worker 属于 `assistant` profile，启用时使用 `docker compose --profile assistant up -d --build`；环境开关和 worker 必须同时启用，入口状态不代表模型可用。

构建镜像前确认构建上下文不含环境文件、备份或本地产物。配置好外部 PostgreSQL 和 Redis 后执行：

```bash
docker compose run --rm --build migrate
docker compose up -d --build
```

初始化命令只建立表结构与必要的系统默认值，不导入业务数据。服务启动后，通过 `/health`及容器日志验证。停机时给 worker 留出 Compose 配置的退出宽限时间。备份、恢复、反向代理及监控由部署者按环境配置；数据库与 Redis 的建议见 [PostgreSQL](docs/deployment/postgresql.md) 和 [Redis](docs/deployment/redis.md)。

停用导购时，先关闭 `ASSISTANT_ENABLED` 并重启 API，再停止对应 worker；保留数据库，不自动回滚迁移。停用期间可运行 `npm run assistant:cleanup` 清理过期会话。故障排查结合任务状态与 worker 日志，不记录会话凭证、对话正文或密钥。
