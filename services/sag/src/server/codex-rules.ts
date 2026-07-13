import { parseRuleIntent, type RuleIntent } from './gateway'

const extractJsonObject = (text: string) => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

const isRuleMode = (value: unknown): value is RuleIntent['mode'] =>
  value === 'block' || value === 'approval' || value === 'audit'

const isRuleTarget = (value: unknown): value is RuleIntent['target'] =>
  value === 'secret' || value === 'operation' || value === 'connector' || value === 'intent' || value === 'identity'

const normalizeCodexRule = (value: unknown): RuleIntent | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string') return null
  if (!isRuleMode(record.mode)) return null
  if (!isRuleTarget(record.target)) return null
  if (typeof record.pattern !== 'string' || record.pattern.trim().length === 0) return null
  return {
    name: record.name.slice(0, 96),
    mode: record.mode,
    target: record.target,
    pattern: record.pattern.slice(0, 240),
    summary: typeof record.summary === 'string' ? record.summary.slice(0, 240) : undefined,
    translator: 'codex-app-server',
  }
}

export const translateRuleWithCodex = async (text: string): Promise<RuleIntent> => {
  const fallback = parseRuleIntent(text)
  if (process.env.SAG_DISABLE_CODEX_RULES === 'true') return fallback

  let client: { runTurn: (prompt: string, options?: unknown) => Promise<{ text: string }>; stop: () => void } | null =
    null
  try {
    const module = (await import('@proompteng/codex')) as {
      CodexAppServerClient: new (options?: unknown) => {
        runTurn: (prompt: string, options?: unknown) => Promise<{ text: string }>
        stop: () => void
      }
    }
    client = new module.CodexAppServerClient({
      binaryPath: process.env.SAG_CODEX_BINARY ?? 'codex',
      cliConfigOverrides: ['mcp_servers={}', 'notify=[]'],
      cwd: process.env.SAG_CODEX_CWD ?? '/tmp',
      sandbox: 'read-only',
      approval: 'never',
      defaultModel: process.env.SAG_CODEX_MODEL ?? 'gpt-5.6-sol',
      defaultEffort: 'high',
      threadConfig: { mcp_servers: {}, web_search: 'live' },
      bootstrapTimeoutMs: 15_000,
      clientInfo: { name: 'sag', title: 'Secure Action Gateway rule translator', version: '0.0.1' },
    })

    const prompt = `Translate this enterprise security policy request into one compact JSON object.

Allowed schema:
{
  "name": "short rule name",
  "mode": "block" | "approval" | "audit",
  "target": "secret" | "operation" | "connector" | "intent" | "identity",
  "pattern": "safe case-insensitive regex without delimiters",
  "summary": "one sentence"
}

Return only JSON. Do not include markdown.

Policy request:
${text}`

    const result = await Promise.race([
      client.runTurn(prompt, { cwd: process.env.SAG_CODEX_CWD ?? '/tmp', effort: 'high' }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('codex rule translation timed out')), 60_000)
      }),
    ])
    const json = extractJsonObject(result.text)
    if (!json) return fallback
    const translated = normalizeCodexRule(JSON.parse(json))
    return translated ?? fallback
  } catch (error) {
    console.error('sag.codex_rule_translation_failed', error)
    return fallback
  } finally {
    client?.stop()
  }
}
