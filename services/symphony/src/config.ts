import path from 'node:path'

import type { AskForApproval, SandboxMode, SandboxPolicy } from '@proompteng/codex'

import { SymphonyError } from './errors'
import type { SymphonyConfig } from './types'
import {
  DEFAULT_WORKSPACE_ROOT,
  expandPathValue,
  hasPathSeparator,
  normalizeStringList,
  readNumber,
  readPositiveNumber,
  normalizeState,
} from './utils'

const DEFAULT_LINEAR_ENDPOINT = 'https://api.linear.app/graphql'
const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress']
const DEFAULT_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']

const readMap = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const resolveMaybeEnvToken = (
  value: unknown,
  env: NodeJS.ProcessEnv,
  fallback: string | null = null,
): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback
  if (!value.startsWith('$')) return value
  const resolved = env[value.slice(1)]?.trim() ?? ''
  return resolved.length > 0 ? resolved : fallback
}

const normalizeWorkspaceRoot = (value: unknown, env: NodeJS.ProcessEnv): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return DEFAULT_WORKSPACE_ROOT
  }
  const expanded = expandPathValue(value.trim(), env)
  if (expanded.length === 0) return DEFAULT_WORKSPACE_ROOT
  if (expanded.startsWith('http://') || expanded.startsWith('https://')) return expanded
  if (hasPathSeparator(expanded) || expanded.startsWith('~') || expanded.startsWith('$') || path.isAbsolute(expanded)) {
    return path.resolve(expanded)
  }
  return expanded
}

const normalizeConcurrencyMap = (value: unknown): Record<string, number> => {
  const raw = readMap(value)
  const entries = Object.entries(raw)
    .map(([key, rawValue]) => {
      const parsed = readPositiveNumber(rawValue, Number.NaN)
      return [normalizeState(key), parsed] as const
    })
    .filter(([, parsed]) => Number.isFinite(parsed) && parsed > 0)
  return Object.fromEntries(entries)
}

export const toSymphonyConfig = (
  workflowPath: string,
  rawConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): SymphonyConfig => {
  const tracker = readMap(rawConfig.tracker)
  const polling = readMap(rawConfig.polling)
  const workspace = readMap(rawConfig.workspace)
  const hooks = readMap(rawConfig.hooks)
  const worker = readMap(rawConfig.worker)
  const agent = readMap(rawConfig.agent)
  const codex = readMap(rawConfig.codex)
  const server = readMap(rawConfig.server)

  return {
    workflowPath: path.resolve(workflowPath),
    tracker: {
      kind: typeof tracker.kind === 'string' ? tracker.kind.trim().toLowerCase() : null,
      endpoint:
        typeof tracker.endpoint === 'string' && tracker.endpoint.trim().length > 0
          ? tracker.endpoint
          : DEFAULT_LINEAR_ENDPOINT,
      apiKey: resolveMaybeEnvToken(tracker.api_key, env, env.LINEAR_API_KEY?.trim() || null),
      projectSlug:
        typeof tracker.project_slug === 'string' && tracker.project_slug.trim().length > 0
          ? tracker.project_slug.trim()
          : null,
      activeStates: normalizeStringList(tracker.active_states, DEFAULT_ACTIVE_STATES),
      terminalStates: normalizeStringList(tracker.terminal_states, DEFAULT_TERMINAL_STATES),
    },
    pollingIntervalMs: readPositiveNumber(polling.interval_ms, 30_000),
    workspaceRoot: normalizeWorkspaceRoot(workspace.root, env),
    hooks: {
      afterCreate:
        typeof hooks.after_create === 'string' && hooks.after_create.trim().length > 0 ? hooks.after_create : null,
      beforeRun: typeof hooks.before_run === 'string' && hooks.before_run.trim().length > 0 ? hooks.before_run : null,
      afterRun: typeof hooks.after_run === 'string' && hooks.after_run.trim().length > 0 ? hooks.after_run : null,
      beforeRemove:
        typeof hooks.before_remove === 'string' && hooks.before_remove.trim().length > 0 ? hooks.before_remove : null,
      timeoutMs: readPositiveNumber(hooks.timeout_ms, 60_000),
    },
    worker: {
      sshHosts: normalizeStringList(worker.ssh_hosts, []),
      maxConcurrentAgentsPerHost:
        readNumber(worker.max_concurrent_agents_per_host, 0) > 0
          ? readPositiveNumber(worker.max_concurrent_agents_per_host, 1)
          : null,
    },
    agent: {
      maxConcurrentAgents: readPositiveNumber(agent.max_concurrent_agents, 10),
      maxConcurrentAgentsByState: normalizeConcurrencyMap(agent.max_concurrent_agents_by_state),
      maxRetryBackoffMs: readPositiveNumber(agent.max_retry_backoff_ms, 300_000),
      maxTurns: readPositiveNumber(agent.max_turns, 20),
    },
    codex: {
      command:
        typeof codex.command === 'string' && codex.command.trim().length > 0
          ? codex.command.trim()
          : 'codex app-server',
      approvalPolicy: (codex.approval_policy ?? null) as AskForApproval | null,
      threadSandbox: (codex.thread_sandbox ?? null) as SandboxMode | null,
      turnSandboxPolicy: (codex.turn_sandbox_policy ?? null) as SandboxPolicy | null,
      turnTimeoutMs: readPositiveNumber(codex.turn_timeout_ms, 3_600_000),
      readTimeoutMs: readPositiveNumber(codex.read_timeout_ms, 5_000),
      stallTimeoutMs: readNumber(codex.stall_timeout_ms, 300_000),
    },
    server: {
      host: typeof server.host === 'string' && server.host.trim().length > 0 ? server.host.trim() : '127.0.0.1',
      port: readNumber(server.port, Number.NaN) >= 0 ? readNumber(server.port, Number.NaN) : null,
    },
  }
}

export const validateDispatchConfig = (config: SymphonyConfig): void => {
  if (!config.tracker.kind) {
    throw new SymphonyError('unsupported_tracker_kind', 'tracker.kind is required')
  }
  if (config.tracker.kind !== 'linear') {
    throw new SymphonyError('unsupported_tracker_kind', `tracker.kind ${config.tracker.kind} is not supported`)
  }
  if (!config.tracker.apiKey) {
    throw new SymphonyError('missing_tracker_api_key', 'tracker.api_key is required')
  }
  if (!config.tracker.projectSlug) {
    throw new SymphonyError('missing_tracker_project_slug', 'tracker.project_slug is required')
  }
  if (!config.codex.command || config.codex.command.trim().length === 0) {
    throw new SymphonyError('invalid_codex_command', 'codex.command must be set')
  }
}
