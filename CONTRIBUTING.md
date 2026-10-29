# 贡献指南

请先阅读 [README](README.md)、[WORKFLOW](WORKFLOW.md)和仓库级 [AGENTS.md](AGENTS.md)。

提交问题时说明复现步骤、预期与实际行为及运行环境，删除密钥、个人信息和业务数据。较大改动建议先通过 issue 讨论范围。

提交变更前运行受影响测试、`npm run typecheck`和`npm run build`。保持变更聚焦，涉及行为变化时补充必要的回归测试。LLM 测试使用 mock 或免费本地模型；不要依赖个人服务器或付费接口。新增 SQL 除基础 ddl.sql、dml.sql 外，使用 `<名称>_YYYYMMDD.sql`命名。

贡献应为你有权提交的内容，并按本项目 GPL-3.0-only 许可提供；引入第三方代码或资料时保留其来源和许可证声明。
