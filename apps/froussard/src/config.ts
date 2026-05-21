import { parseBrokerList } from '@/utils/kafka'

const requireEnv = (env: NodeJS.ProcessEnv, name: string): string => {
  const value = env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const requireFirstEnv = (env: NodeJS.ProcessEnv, names: string[]): string => {
  for (const name of names) {
    const value = env[name]
    if (value) return value
  }
  throw new Error(`Missing required environment variable: ${names[0]}`)
}

const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000
const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 10_000
const DEFAULT_AGENTS_SERVICE_BASE_URL = 'http://agents.agents.svc.cluster.local'
const DEFAULT_AGENTS_SERVICE_CLIENT_NAME = 'froussard'
const DEFAULT_AGENTS_NAMESPACE = 'agents'
const DEFAULT_AGENTS_AGENT_NAME = 'codex-agent'
const DEFAULT_AGENTS_VCS_PROVIDER = 'github'
const DEFAULT_AGENTS_SERVICE_ACCOUNT = 'agents-sa'
const DEFAULT_AGENTS_SECRETS = ['github-token', 'codex-auth']
const DEFAULT_AGENTS_SECRET_BINDING_REF = 'codex-github-token'
const DEFAULT_AGENTS_TTL_SECONDS_AFTER_FINISHED = 86_400
const DEFAULT_AGENTS_GOAL_TOKEN_BUDGET = 250_000

export interface AppConfig {
  idempotency: {
    ttlMs: number
    maxEntries: number
  }
  githubWebhookSecret: string
  atlas: {
    baseUrl: string
    apiKey: string | null
  }
  agents: {
    serviceBaseUrl: string
    serviceClientName: string
    namespace: string
    agentName: string
    vcsProviderName: string
    serviceAccountName: string
    secrets: string[]
    secretBindingRef: string
    ttlSecondsAfterFinished: number
    goalTokenBudget: number
  }
  kafka: {
    brokers: string[]
    username: string
    password: string
    clientId: string
    topics: {
      raw: string
      discordCommands: string
    }
  }
  codebase: {
    baseBranch: string
    branchPrefix: string
  }
  codex: {
    triggerLogins: string[]
    workflowLogin: string
    implementationTriggerPhrase: string
  }
  discord: {
    publicKey: string
    defaultResponse: {
      deferType: 'channel-message'
      ephemeral: boolean
    }
  }
  github: {
    token: string | null
    ackReaction: string
    apiBaseUrl: string
    userAgent: string
  }
}

const parseNonNegativeInt = (value: string | undefined, fallback: number): number => {
  if (typeof value !== 'string') {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return fallback
  }
  return parsed
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (typeof value !== 'string') {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    return fallback
  }
  return parsed
}

const parseCsv = (raw: string | undefined, fallback: string[]) => {
  const values = raw
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return values && values.length > 0 ? values : fallback
}

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')

const readOptionalEnv = (env: NodeJS.ProcessEnv, name: string, fallback: string): string => {
  const value = env[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const brokers = parseBrokerList(requireEnv(env, 'KAFKA_BROKERS'))
  if (brokers.length === 0) {
    throw new Error('KAFKA_BROKERS must include at least one broker host:port')
  }

  const atlasBaseUrl = trimTrailingSlash(requireFirstEnv(env, ['ATLAS_BASE_URL', 'JANGAR_BASE_URL']))
  const idempotencyTtlSecondsRaw = env.FROUSSARD_WEBHOOK_IDEMPOTENCY_TTL_SECONDS
  const idempotencyTtlMs =
    typeof idempotencyTtlSecondsRaw === 'string' && idempotencyTtlSecondsRaw.trim() !== ''
      ? parseNonNegativeInt(idempotencyTtlSecondsRaw, DEFAULT_IDEMPOTENCY_TTL_MS / 1000) * 1000
      : parseNonNegativeInt(env.FROUSSARD_WEBHOOK_IDEMPOTENCY_TTL_MS, DEFAULT_IDEMPOTENCY_TTL_MS)
  const idempotencyMaxEntries = parseNonNegativeInt(
    env.FROUSSARD_WEBHOOK_IDEMPOTENCY_MAX_ENTRIES,
    DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
  )

  return {
    idempotency: {
      ttlMs: idempotencyTtlMs,
      maxEntries: idempotencyMaxEntries,
    },
    githubWebhookSecret: requireEnv(env, 'GITHUB_WEBHOOK_SECRET'),
    atlas: {
      baseUrl: atlasBaseUrl,
      apiKey: env.JANGAR_API_KEY?.trim() || null,
    },
    agents: {
      serviceBaseUrl: trimTrailingSlash(
        readOptionalEnv(env, 'AGENTS_SERVICE_BASE_URL', DEFAULT_AGENTS_SERVICE_BASE_URL),
      ),
      serviceClientName: readOptionalEnv(env, 'AGENTS_SERVICE_CLIENT_NAME', DEFAULT_AGENTS_SERVICE_CLIENT_NAME),
      namespace: readOptionalEnv(env, 'AGENTS_NAMESPACE', DEFAULT_AGENTS_NAMESPACE),
      agentName: readOptionalEnv(env, 'AGENTS_CODEX_AGENT_NAME', DEFAULT_AGENTS_AGENT_NAME),
      vcsProviderName: readOptionalEnv(env, 'AGENTS_VCS_PROVIDER_NAME', DEFAULT_AGENTS_VCS_PROVIDER),
      serviceAccountName: readOptionalEnv(env, 'AGENTS_SERVICE_ACCOUNT_NAME', DEFAULT_AGENTS_SERVICE_ACCOUNT),
      secrets: parseCsv(env.AGENTS_CODEX_SECRETS, DEFAULT_AGENTS_SECRETS),
      secretBindingRef: readOptionalEnv(env, 'AGENTS_CODEX_SECRET_BINDING_REF', DEFAULT_AGENTS_SECRET_BINDING_REF),
      ttlSecondsAfterFinished: parseNonNegativeInt(
        env.AGENTS_CODEX_TTL_SECONDS_AFTER_FINISHED,
        DEFAULT_AGENTS_TTL_SECONDS_AFTER_FINISHED,
      ),
      goalTokenBudget: parsePositiveInt(env.AGENTS_CODEX_GOAL_TOKEN_BUDGET, DEFAULT_AGENTS_GOAL_TOKEN_BUDGET),
    },
    kafka: {
      brokers,
      username: requireEnv(env, 'KAFKA_USERNAME'),
      password: requireEnv(env, 'KAFKA_PASSWORD'),
      clientId: env.KAFKA_CLIENT_ID ?? 'froussard-webhook-producer',
      topics: {
        raw: requireEnv(env, 'KAFKA_TOPIC'),
        discordCommands: requireEnv(env, 'KAFKA_DISCORD_COMMAND_TOPIC'),
      },
    },
    codebase: {
      baseBranch: env.CODEX_BASE_BRANCH ?? 'main',
      branchPrefix: env.CODEX_BRANCH_PREFIX ?? 'codex/issue-',
    },
    codex: {
      triggerLogins: parseTriggerLogins(env),
      workflowLogin:
        typeof env.CODEX_WORKFLOW_LOGIN === 'string' && env.CODEX_WORKFLOW_LOGIN.trim().length > 0
          ? env.CODEX_WORKFLOW_LOGIN.trim().toLowerCase()
          : 'github-actions[bot]',
      implementationTriggerPhrase: (env.CODEX_IMPLEMENTATION_TRIGGER ?? 'implement issue').trim(),
    },
    discord: {
      publicKey: requireEnv(env, 'DISCORD_PUBLIC_KEY'),
      defaultResponse: {
        deferType: 'channel-message',
        ephemeral: (env.DISCORD_DEFAULT_EPHEMERAL ?? 'true').toLowerCase() === 'true',
      },
    },
    github: {
      token: env.GITHUB_TOKEN ?? null,
      ackReaction: env.GITHUB_ACK_REACTION ?? '+1',
      apiBaseUrl: env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
      userAgent: env.GITHUB_USER_AGENT ?? 'froussard-webhook',
    },
  }
}

const parseTriggerLogins = (env: NodeJS.ProcessEnv): string[] => {
  const raw = env.CODEX_TRIGGER_LOGINS ?? env.CODEX_TRIGGER_LOGIN ?? 'gregkonush,tuslagch'
  const logins = raw
    .split(',')
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login.length > 0)
  return logins.length > 0 ? logins : ['gregkonush', 'tuslagch']
}
