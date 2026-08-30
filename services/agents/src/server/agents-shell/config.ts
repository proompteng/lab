import {
  AGENTS_SHELL_VERSION,
  DEFAULT_AGENT_BASE_BRANCH,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_NAMESPACE,
  DEFAULT_AGENT_REPOSITORY,
  DEFAULT_AGENT_RUNTIME_SERVICE_ACCOUNT,
  DEFAULT_AGENT_SECRETS,
  DEFAULT_AGENT_TOKEN_BUDGET,
  DEFAULT_AGENT_TTL_SECONDS_AFTER_FINISHED,
  DEFAULT_AGENT_VCS_REF,
  DEFAULT_ISSUER,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_RESOURCE,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_SECONDS,
  SCOPES,
} from './constants'

export type AgentsShellConfig = {
  name: string
  version: string
  resource: string
  issuer: string
  jwksUrl: string
  supportedScopes: string[]
  allowedEmails: Set<string>
  allowedUsernames: Set<string>
  allowedSubjects: Set<string>
  workspaceRoot: string
  defaultTimeoutSeconds: number
  maxTimeoutSeconds: number
  defaultOutputBytes: number
  maxOutputBytes: number
  maxConcurrentJobs: number
  auditLogPath: string | null
  allowedK8sNamespaces: Set<string>
  k8sApplyEnabled: boolean
  agentNamespace: string
  agentName: string
  agentRepository: string
  agentBaseBranch: string
  agentVcsRef: string
  agentRuntimeServiceAccount: string
  agentSecrets: string[]
  agentDefaultTokenBudget: number
  agentDefaultTtlSecondsAfterFinished: number
  port: number
  host: string
}

const parseList = (value: string | undefined) =>
  new Set(
    (value ?? '')
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  )

const parseArray = (value: string | undefined, fallback: string[]) => {
  const parsed = Array.from(parseList(value))
  return parsed.length > 0 ? parsed : fallback
}

const parseListenPort = (env: NodeJS.ProcessEnv) => {
  const raw = env.PORT ?? env.AGENTS_SHELL_LISTEN_PORT ?? '8080'
  if (!/^\d+$/.test(raw)) {
    throw new Error(`listen port must be a numeric TCP port, got ${raw}`)
  }
  const port = Number(raw)
  if (port < 1 || port > 65535) {
    throw new Error(`listen port must be between 1 and 65535, got ${raw}`)
  }
  return port
}

export const defaultAgentsShellConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): AgentsShellConfig => {
  const issuer = env.AGENTS_SHELL_OAUTH_ISSUER ?? DEFAULT_ISSUER
  const resource = env.AGENTS_SHELL_RESOURCE ?? DEFAULT_RESOURCE

  return {
    name: 'agents-shell',
    version: AGENTS_SHELL_VERSION,
    resource,
    issuer,
    jwksUrl: env.AGENTS_SHELL_JWKS_URL ?? `${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`,
    supportedScopes: ['openid', 'email', 'profile', SCOPES.offlineAccess, SCOPES.read, SCOPES.write, SCOPES.admin],
    allowedEmails: parseList(env.AGENTS_SHELL_ALLOWED_EMAILS),
    allowedUsernames: parseList(env.AGENTS_SHELL_ALLOWED_USERNAMES),
    allowedSubjects: parseList(env.AGENTS_SHELL_ALLOWED_SUBJECTS),
    workspaceRoot: env.AGENTS_SHELL_WORKSPACE_ROOT ?? '/workspace',
    defaultTimeoutSeconds: Number(env.AGENTS_SHELL_DEFAULT_TIMEOUT_SECONDS ?? String(DEFAULT_TIMEOUT_SECONDS)),
    maxTimeoutSeconds: Number(env.AGENTS_SHELL_MAX_TIMEOUT_SECONDS ?? String(MAX_TIMEOUT_SECONDS)),
    defaultOutputBytes: Number(env.AGENTS_SHELL_DEFAULT_OUTPUT_BYTES ?? String(DEFAULT_OUTPUT_BYTES)),
    maxOutputBytes: Number(env.AGENTS_SHELL_MAX_OUTPUT_BYTES ?? String(MAX_OUTPUT_BYTES)),
    maxConcurrentJobs: Number(env.AGENTS_SHELL_MAX_CONCURRENT_JOBS ?? '4'),
    auditLogPath: env.AGENTS_SHELL_AUDIT_LOG_PATH ?? '/workspace/.agents-shell/audit.jsonl',
    allowedK8sNamespaces: parseList(env.AGENTS_SHELL_ALLOWED_K8S_NAMESPACES ?? 'agents'),
    k8sApplyEnabled: env.AGENTS_SHELL_ENABLE_K8S_APPLY === 'true',
    agentNamespace: env.AGENTS_SHELL_AGENT_NAMESPACE ?? DEFAULT_AGENT_NAMESPACE,
    agentName: env.AGENTS_SHELL_AGENT_NAME ?? DEFAULT_AGENT_NAME,
    agentRepository: env.AGENTS_SHELL_AGENT_REPOSITORY ?? DEFAULT_AGENT_REPOSITORY,
    agentBaseBranch: env.AGENTS_SHELL_AGENT_BASE_BRANCH ?? DEFAULT_AGENT_BASE_BRANCH,
    agentVcsRef: env.AGENTS_SHELL_AGENT_VCS_REF ?? DEFAULT_AGENT_VCS_REF,
    agentRuntimeServiceAccount: env.AGENTS_SHELL_AGENT_RUNTIME_SERVICE_ACCOUNT ?? DEFAULT_AGENT_RUNTIME_SERVICE_ACCOUNT,
    agentSecrets: parseArray(env.AGENTS_SHELL_AGENT_SECRETS, DEFAULT_AGENT_SECRETS),
    agentDefaultTokenBudget: Number(env.AGENTS_SHELL_AGENT_DEFAULT_TOKEN_BUDGET ?? DEFAULT_AGENT_TOKEN_BUDGET),
    agentDefaultTtlSecondsAfterFinished: Number(
      env.AGENTS_SHELL_AGENT_DEFAULT_TTL_SECONDS_AFTER_FINISHED ?? DEFAULT_AGENT_TTL_SECONDS_AFTER_FINISHED,
    ),
    port: parseListenPort(env),
    host: env.HOST ?? env.AGENTS_SHELL_HOST ?? '0.0.0.0',
  }
}
