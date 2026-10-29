# 开发启动脚本

`dev.ts` 是根目录 `npm run dev` 的入口，协调 API、Vite 和按配置启用的 worker。

后端脚本位于 `apps/api/scripts/`：

- `migrate.ts`：首次安装时使用 `npm run db:migrate` 初始化空数据库，自动按顺序执行全部数据库脚本并记录状态，无需手动逐个运行。
- `evaluate-standardization.ts`：使用测试 fixtures 和 mock 响应执行离线回归评估，不连接数据库或真实模型。
