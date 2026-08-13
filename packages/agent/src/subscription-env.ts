/**
 * process.env minus every Anthropic auth override, so the Agent SDK falls back
 * to the user's Claude *subscription* login instead of API-key auth.
 *
 * Required by everything that talks to claude.ai MCP connectors: the real-mode
 * ingest fetch (ingest/adapters/real/connector.ts) and the interactive chat
 * path (llm/sdk.ts), which inherits those connectors. claude.ai connectors only
 * load under the subscription login, never under ANTHROPIC_API_KEY/AUTH_TOKEN
 * (verified in the 2026-07-27 M4 spike). Lives in its own module so both the
 * llm and ingest layers can share it without an import cycle.
 */
export function subscriptionEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN') continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue;
    env[key] = value;
  }
  return env;
}
