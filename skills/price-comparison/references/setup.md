# Configure the current agent

`price-comparison setup` configures access for the agent running this command.
Use the user's existing native configuration. Do not create a skill-specific
file, change the model provider key, install MCP, or edit another agent's config.

1. Identify the current host from the runtime, not from the model's name.
   A DeepSeek model inside Codex still uses Codex configuration.
2. Use `https://price.yufu.pub` by default; ordinary users only fill their API
   key. Do not ask for a site URL or write `PRICE_COMPARISON_URL` unless the user
   wants a different deployment. Preserve any existing custom URL. For an
   explicitly requested self-hosted site, set the optional URL as described below.
3. Use the appropriate native configuration below, honoring custom config home
   locations. Preserve unrelated settings and any existing key. Inspect or
   update configuration programmatically without returning secret values in
   tool output. Do not print a whole settings file.
4. Let the user fill `PRICE_COMPARISON_API_KEY` through the host's private input
   surface or by editing that native config locally. If no private input
   mechanism exists, prepare the non-secret fields and show the file location
   and minimal snippet below. Do not ask them to paste a key into the chat.
   Never pass a plaintext key in a shell command or save it in the repository.
5. Start a fresh session if the host needs to reload its environment, then run
   `node "<skill-directory>/scripts/query.mjs" check`. Only report configured
   and verified after it succeeds. Until then report what remains to be done.

The following snippets show placement, not replacements for entire files.
Only `<your-issued-key>` needs to be filled locally for the default service.

## Codex

Merge into the user `config.toml` under `$CODEX_HOME`, default `~/.codex`.
Use the existing table if present; do not append a duplicate TOML table.

```toml
[shell_environment_policy.set]
PRICE_COMPARISON_API_KEY = "<your-issued-key>"
```

If environment inclusion filters are configured, retain the user's policy and
ensure the key variable and any custom URL variable are permitted. Restart Codex
after changes.

## Claude Code

Merge into the `env` object in `settings.json` under `$CLAUDE_CONFIG_DIR`,
default `~/.claude`. Use user scope so the key is not committed with a project.

```json
{
  "env": {
    "PRICE_COMPARISON_API_KEY": "<your-issued-key>"
  }
}
```

Restart the session if the new variables are not visible to the query script.

## DeepSeek Harness

Use the Harness's existing home `.env` under `$DSH_HOME`, default `~/.dsh`.
Merge this entry without changing the rest of the file:

```dotenv
PRICE_COMPARISON_API_KEY=<your-issued-key>
```

The bundled helper reads the key and any optional URL when running inside a Harness shell
(`DSH_SHELL=1` with `DSH_HOME`). It does not copy them to a separate config.
Explicit shell environment values take precedence. Do not put the key in the
model provider's `DEEPSEEK_API_KEY` field or assume the Harness credential store
automatically exports credentials to shell processes.

## Self-hosted service

Only when the user wants a different deployment, set `PRICE_COMPARISON_URL` in
the same native table, object or environment file as the key. Use that site's
origin, such as `https://prices.example`, without an API path. The key must be
issued by that deployment. Removing the override restores the default service.
Never replace a custom URL with the default after a connection or validation
failure, and do not overwrite it when updating the key.

## Other hosts

Use that host's documented native environment or secret injection mechanism
to expose the key and optional custom URL to the script. Verify it before claiming
support; do not invent a settings field or require a separate skill config.

## Official references

- Codex: https://developers.openai.com/codex/config-reference/
- Claude Code: https://code.claude.com/docs/en/settings
- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/credentials/credentials-local/README.md
