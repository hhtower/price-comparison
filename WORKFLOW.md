# 开发与部署流程

## 本地开发

按 [README](README.md)安装依赖、配置 PostgreSQL/Redis 并初始化数据库。`npm run dev`统一启动 API 和前端；AI worker 是否启动由环境开关及模型配置决定。不要将实际密钥写入源码、测试或提交记录。

首次安装时，对新建的空数据库执行一次 `npm run db:migrate`，命令自动按顺序建立完整数据库结构并记录执行状态，无需手动选择或逐个执行脚本。API、crawler 和各 worker 共用该数据库，初始化完成后再启动进程；各进程需使用一致的配置及代码版本。

## 验证

运行 `npm run typecheck`、`npm run build`及受影响测试。`npm test`包含 Node 测试与 Vitest 前端测试；集成测试仅使用专用的 `TEST_DATABASE_URL`、`TEST_REDIS_URL`，或测试自动创建的 Docker 临时容器，不回退使用部署连接。未提供测试连接时，部分测试会跳过或提示缺少配置；使用临时容器的测试需要 Docker。

LLM 调用通过共享 AI runtime 发送，必须流式传输；分块在内存聚合，完整响应通过 schema、业务约束及长度检查后原子保存。worker 复用共享并发、超时、取消及重试规则。相关测试使用 mock 或免费本地模型。

## 生产部署

服务器使用本仓库的源码与目录结构。npm 部署从项目根目录安装依赖并重新构建；Docker 部署从项目根目录构建镜像，容器内运行编译产物。

更新部署前备份业务数据库，停止相关进程后清除旧 `dist/`，再执行 `npm ci`、`npm run db:migrate` 和 `npm run build`，完成后启动 API 与所需 worker。Docker 部署重新构建镜像并重建容器。保留部署环境的 `.env`、业务数据库和持久化卷，不用源码覆盖它们。

`docker-compose.yml`提供 API 与独立 worker 的示例，数据库与 Redis 由部署者提供。先创建 `.env`，配置容器可访问的数据库地址、强管理密码、站点 HTTPS origin 及所需 worker 开关。设置反向代理时，应仅在代理覆盖转发头且 API 不可被绕过时启用 `TRUST_PROXY`。

构建镜像前确认构建上下文不含环境文件、备份或本地产物。配置好外部 PostgreSQL 和 Redis 后执行：

```bash
docker compose run --rm --build migrate
docker compose up -d --build
```

初始化命令只建立表结构与必要的系统默认值，不导入业务数据。服务启动后，通过 `/health`及容器日志验证。停机时给 worker 留出 Compose 配置的退出宽限时间。备份、恢复、反向代理及监控由部署者按环境配置；数据库与 Redis 的建议见 [PostgreSQL](docs/deployment/postgresql.md) 和 [Redis](docs/deployment/redis.md)。
