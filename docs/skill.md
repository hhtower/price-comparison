# Skill 接入

在网站的「Skill / MCP 接入」页面（`/mcp`）申请并领取密钥。已有 MCP 密钥可直接使用，不必再次申请；两种方式共用有效期、请求额度和撤销状态。

## 安装

复制接入页上的「Skill 安装与配置指令」，发送给你的智能体。它会从本站下载技能，安装到当前智能体的技能目录，并引导你配置密钥。

支持 Codex、Claude Code 和 DeepSeek Harness 的技能目录与配置方式。需要 Node.js 22+，并允许智能体执行查询脚本、连接本站；不需要安装 npm 依赖或配置 MCP。其他兼容 Agent Skills 的宿主可使用同一技能，但需按该宿主的文档设置环境变量。

也可从项目仓库 `skills/price-comparison` 复制技能目录。每个智能体分别安装、配置；不要把密钥写入下载的技能文件。

## 配置指令

启动智能体后，输入：

```text
使用 price-comparison skill 配置密钥
```

也可通过客户端的技能调用方式触发：

| 客户端 | 配置指令 |
| --- | --- |
| Codex | `$price-comparison setup` |
| Claude Code | `/price-comparison setup` |
| DeepSeek Harness | 选择 `price-comparison` 技能后输入 `setup`，或使用上面的自然语言指令 |

默认服务地址为 `https://price.yufu.pub`，一般用户只需填写已领取的密钥，无需设置地址。智能体根据当前宿主准备原生配置；没有私密输入界面时，它会指出需要编辑的宿主配置文件。不要把完整密钥发送到聊天或提交到代码仓库。不会单独创建此 Skill 的配置文件，也不会在每次启动时重复要求填写密钥。

| 客户端 | 原生配置位置 |
| --- | --- |
| Codex | 用户 `config.toml` 的 `shell_environment_policy.set` |
| Claude Code | 用户 `settings.json` 的 `env` |
| DeepSeek Harness | Harness 主目录的 `.env` |

自定义配置目录沿用宿主设置。必填项只有 `PRICE_COMPARISON_API_KEY`（领取的共用密钥）。

使用自部署服务时，在同一原生配置中额外设置 `PRICE_COMPARISON_URL`，覆盖默认地址，例如 `https://prices.example`。地址只填 origin，无需填写接口路径，密钥也应由该部署签发。已有自定义地址会保留；移除该配置即可恢复默认服务。显式指定的地址无效或连接失败时，不会自动切换到默认服务。

Codex / Claude Code 如果尚未读取新配置，重新启动会话后检查连接。配置完成以连接检查成功为准；模型服务的 API key 与本站密钥无关。

## 使用

直接对智能体说：

> 查一下 ChatGPT Plus 代充报价，按同币种、同期限比较，列出商家、价格、质保条件和采集时间。

> 看看这个商品最近一个月的价格走势。

技能只查询本站收录的数据，不自动下单。报价是采集快照，最终价格与库存以商家为准。搜索结果、分页结果与价格历史都可能需要进一步核对，不能把局部结果当作全站最低价。

## 排查

- 未配置：再次执行配置指令，在当前智能体中保存密钥。
- 无法连接：确认本站地址、Node.js 版本及宿主的联网权限。
- 密钥失效：在同一个接入页查看状态，必要时联系管理员重新发放，并更新各客户端的配置。
- 请求过多：稍后再试；Skill 与 MCP 共用同一把密钥的额度。一次脚本执行包含协议初始化和查询等多个请求。

原生配置依据：Codex 官方配置参考（`developers.openai.com/codex/config-reference/`）、Claude Code 官方 Settings 文档（`code.claude.com/docs/en/settings`）、DeepSeek Harness 的 `credentials-local` 和 `skill-filesystem` 官方源码文档。技能内的 `references/setup.md` 提供对应来源和配置片段。
