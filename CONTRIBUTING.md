# 贡献指南

请先阅读 [README](README.md)、[WORKFLOW](WORKFLOW.md) 和仓库级 [AGENTS.md](AGENTS.md)。参与讨论和贡献时请遵守 [行为准则](CODE_OF_CONDUCT.md)。

提交 Issue 时请选择问题反馈或功能建议模板。问题反馈请说明项目版本或 Git commit、部署方式、复现步骤、预期与实际行为及运行环境，删除密钥、个人信息和业务数据。较大改动建议先通过 Issue 讨论范围。安全漏洞请按 [SECURITY.md](SECURITY.md) 私密反馈，不要在公开 Issue 或 PR 中提供漏洞细节。

提交 PR 时按模板说明改动原因、关联 Issue、实际验证结果与升级注意事项；涉及界面时提供截图。

代码变更提交前运行受影响测试、`npm run typecheck` 和 `npm run build`。保持变更聚焦，涉及行为变化时补充必要的回归测试。LLM 测试使用 mock 或免费本地模型；不要依赖个人服务器或付费接口。仅文档或文案修改时检查内容和链接即可。新增 SQL 除基础 `ddl.sql`、`dml.sql` 外，使用 `<名称>_YYYYMMDD.sql` 命名。

贡献应为你有权提交的内容，并按本项目 GPL-3.0-only 许可提供；引入第三方代码或资料时保留其来源和许可证声明。
