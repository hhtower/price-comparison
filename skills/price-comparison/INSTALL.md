# Install price-comparison

Install this skill when the user asks to use the site's catalog in their agent.
Do not install or configure an MCP server.

Download the following files from the same directory URL as this document,
preserving the relative paths:

- `SKILL.md`
- `references/setup.md`
- `scripts/query.mjs`

Place them in the current host's user skill directory:

| Host | Skill directory |
| --- | --- |
| Codex | `~/.agents/skills/price-comparison/` |
| Claude Code | `$CLAUDE_CONFIG_DIR/skills/price-comparison/`, default `~/.claude/skills/price-comparison/` |
| DeepSeek Harness | `$DSH_HOME/skills/price-comparison/`, default `~/.dsh/skills/price-comparison/` |

Respect the host's actual configured skill roots if customized. For other hosts,
use their documented skill directory. No global npm install is needed; the
query helper requires Node.js 22+.

Review the downloaded files before running the helper. If an installed copy
has local changes, preserve those changes and explain the conflict instead of
overwriting them. For an ordinary update, replace the skill's files while
leaving the host's native settings untouched.

Next, read `SKILL.md` and run its `setup` instructions for the current agent.
The default service is `https://price.yufu.pub`; the user only fills their
already-issued key in the agent's native configuration. Preserve an existing
custom `PRICE_COMPARISON_URL`. If the user explicitly requests the self-hosted
site supplying this installation instruction, use that site's origin as the
optional override; a repository or download mirror is not a service address. Do not
request a second application or put a key in this directory or in chat.

After installation the user can invoke `price-comparison setup` through their
host's skill invocation syntax, or simply say "configure the price-comparison
skill". Queries require the agent's normal shell and network permissions.
