import path from 'node:path'

import type * as ParseResult from '@effect/schema/ParseResult'
import * as Schema from '@effect/schema/Schema'
import * as TreeFormatter from '@effect/schema/TreeFormatter'
import { Effect } from 'effect'

import { ConfigError } from './errors'
import type { HealthCheckConfig, ReleaseDeployableConfig, SymphonyConfig } from './types'
import {
  DEFAULT_WORKSPACE_ROOT,
  expandPathValue,
  hasPathSeparator,
  normalizeState,
  normalizeStringList,
  readNumber,
  readPositiveNumber,
} from './utils'

const DEFAULT_LINEAR_ENDPOINT = 'https://api.linear.app/graphql'
const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress']
const DEFAULT_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']
const DEFAULT_BLOCKED_LABELS = ['manual-only', 'secret-rotation', 'cluster-recovery', 'cross-repo', 'db-migration']

const RawSectionSchema = Schema.Struct({
  tracker: Schema.optionalWith(
    Schema.Struct({
      kind: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      endpoint: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      api_key: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      project_slug: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      active_states: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      terminal_states: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      handoff_state: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  polling: Schema.optionalWith(
    Schema.Struct({
      interval_ms: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  workspace: Schema.optionalWith(
    Schema.Struct({
      root: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  hooks: Schema.optionalWith(
    Schema.Struct({
      after_create: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      before_run: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      after_run: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      before_remove: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      timeout_ms: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  worker: Schema.optionalWith(
    Schema.Struct({
      ssh_hosts: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      max_concurrent_agents_per_host: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  agent: Schema.optionalWith(
    Schema.Struct({
      max_concurrent_agents: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      max_concurrent_agents_by_state: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      max_retry_backoff_ms: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      max_turns: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  codex: Schema.optionalWith(
    Schema.Struct({
      command: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      approval_policy: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      thread_sandbox: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      turn_sandbox_policy: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      turn_timeout_ms: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      read_timeout_ms: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      stall_timeout_ms: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  server: Schema.optionalWith(
    Schema.Struct({
      host: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      port: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  instance: Schema.optionalWith(
    Schema.Struct({
      name: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      namespace: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      argocd_application: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  target: Schema.optionalWith(
    Schema.Struct({
      name: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      namespace: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      argocd_application: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      repo: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      default_branch: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  release: Schema.optionalWith(
    Schema.Struct({
      mode: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      required_checks_source: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      promotion_branch_prefix: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      blocked_labels: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      deployables: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
  health: Schema.optionalWith(
    Schema.Struct({
      pre_dispatch: Schema.optionalWith(Schema.Unknown, { nullable: true }),
      post_deploy: Schema.optionalWith(Schema.Unknown, { nullable: true }),
    }),
    { nullable: true },
  ),
})

type RawConfigSections = typeof RawSectionSchema.Type

const decodeRawSections = Schema.decodeUnknown(RawSectionSchema)

const formatSchemaError = (error: ParseResult.ParseError): string => TreeFormatter.formatErrorSync(error)

const mapSchemaError = <A>(
  effect: Effect.Effect<A, ParseResult.ParseError, never>,
): Effect.Effect<A, ConfigError, never> =>
  effect.pipe(Effect.mapError((error) => new ConfigError('workflow_parse_error', formatSchemaError(error), error)))

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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, rawValue]) => {
        const parsed = readPositiveNumber(rawValue, Number.NaN)
        return [normalizeState(key), parsed] as const
      })
      .filter(([, parsed]) => Number.isFinite(parsed) && parsed > 0),
  )
}

const readString = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback

const normalizeManifestPaths = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
    : []

const normalizeDeployables = (value: unknown): ReleaseDeployableConfig[] => {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []

    const raw = entry as Record<string, unknown>
    const name = readString(raw.name, '')
    const image = readString(raw.image, '')
    if (!name || !image) return []

    return [
      {
        name,
        image,
        manifestPaths: normalizeManifestPaths(raw.manifest_paths),
        buildWorkflow:
          typeof raw.build_workflow === 'string' && raw.build_workflow.trim().length > 0
            ? raw.build_workflow.trim()
            : null,
        releaseWorkflow:
          typeof raw.release_workflow === 'string' && raw.release_workflow.trim().length > 0
            ? raw.release_workflow.trim()
            : null,
        postDeployWorkflow:
          typeof raw.post_deploy_workflow === 'string' && raw.post_deploy_workflow.trim().length > 0
            ? raw.post_deploy_workflow.trim()
            : null,
      } satisfies ReleaseDeployableConfig,
    ]
  })
}

const normalizeHealthChecks = (value: unknown): HealthCheckConfig[] => {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []

    const raw = entry as Record<string, unknown>
    const name = readString(raw.name, '')
    const type = readString(raw.type, '') as HealthCheckConfig['type'] | ''
    if (!name || !type) return []

    if (!['argocd_application', 'http', 'knative_service', 'kubernetes_resource'].includes(type)) return []

    return [
      {
        name,
        type,
        namespace: typeof raw.namespace === 'string' && raw.namespace.trim().length > 0 ? raw.namespace.trim() : null,
        application:
          typeof raw.application === 'string' && raw.application.trim().length > 0 ? raw.application.trim() : null,
        url: typeof raw.url === 'string' && raw.url.trim().length > 0 ? raw.url.trim() : null,
        expectedStatus:
          readNumber(raw.expected_status, Number.NaN) >= 0 ? readNumber(raw.expected_status, Number.NaN) : null,
        expectedSync:
          typeof raw.expected_sync === 'string' && raw.expected_sync.trim().length > 0
            ? raw.expected_sync.trim()
            : null,
        expectedHealth:
          typeof raw.expected_health === 'string' && raw.expected_health.trim().length > 0
            ? raw.expected_health.trim()
            : null,
        resourceKind:
          typeof raw.resource_kind === 'string' && raw.resource_kind.trim().length > 0
            ? raw.resource_kind.trim()
            : null,
        resourceName:
          typeof raw.resource_name === 'string' && raw.resource_name.trim().length > 0
            ? raw.resource_name.trim()
            : null,
        path: typeof raw.path === 'string' && raw.path.trim().length > 0 ? raw.path.trim() : null,
      } satisfies HealthCheckConfig,
    ]
  })
}

const normalizeConfig = (
  workflowPath: string,
  rawConfig: RawConfigSections,
  env: NodeJS.ProcessEnv,
): SymphonyConfig => {
  const tracker = rawConfig.tracker ?? {}
  const polling = rawConfig.polling ?? {}
  const workspace = rawConfig.workspace ?? {}
  const hooks = rawConfig.hooks ?? {}
  const worker = rawConfig.worker ?? {}
  const agent = rawConfig.agent ?? {}
  const codex = rawConfig.codex ?? {}
  const server = rawConfig.server ?? {}
  const instance = rawConfig.instance ?? {}
  const target = rawConfig.target ?? {}
  const release = rawConfig.release ?? {}
  const health = rawConfig.health ?? {}

  const targetName = readString(target.name, 'symphony')
  const targetNamespace = readString(target.namespace, 'jangar')
  const argocdApplication = readString(target.argocd_application, targetName)
  const instanceName = readString(instance.name, argocdApplication)
  const instanceNamespace = readString(instance.namespace, targetNamespace)
  const instanceArgocdApplication = readString(instance.argocd_application, instanceName)
  const repo = readString(target.repo, 'proompteng/lab')
  const defaultBranch = readString(target.default_branch, 'main')
  const promotionBranchPrefix = readString(release.promotion_branch_prefix, `codex/${targetName}-release-`)

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
      handoffState: readString(tracker.handoff_state, 'Backlog'),
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
      approvalPolicy: typeof codex.approval_policy === 'string' ? (codex.approval_policy as never) : null,
      threadSandbox: typeof codex.thread_sandbox === 'string' ? (codex.thread_sandbox as never) : null,
      turnSandboxPolicy:
        codex.turn_sandbox_policy && typeof codex.turn_sandbox_policy === 'object'
          ? (codex.turn_sandbox_policy as never)
          : null,
      turnTimeoutMs: readPositiveNumber(codex.turn_timeout_ms, 3_600_000),
      readTimeoutMs: readPositiveNumber(codex.read_timeout_ms, 5_000),
      stallTimeoutMs: readNumber(codex.stall_timeout_ms, 300_000),
    },
    server: {
      host: typeof server.host === 'string' && server.host.trim().length > 0 ? server.host.trim() : '127.0.0.1',
      port: readNumber(server.port, Number.NaN) >= 0 ? readNumber(server.port, Number.NaN) : null,
    },
    instance: {
      name: instanceName,
      namespace: instanceNamespace,
      argocdApplication: instanceArgocdApplication,
    },
    target: {
      name: targetName,
      namespace: targetNamespace,
      argocdApplication,
      repo,
      defaultBranch,
    },
    release: {
      mode: readString(release.mode, 'gitops_pr_on_main'),
      requiredChecksSource: readString(release.required_checks_source, 'branch_protection'),
      promotionBranchPrefix,
      blockedLabels: normalizeStringList(release.blocked_labels, DEFAULT_BLOCKED_LABELS).map((label) =>
        normalizeState(label),
      ),
      deployables: normalizeDeployables(release.deployables),
    },
    health: {
      preDispatch: normalizeHealthChecks(health.pre_dispatch),
      postDeploy: normalizeHealthChecks(health.post_deploy),
    },
  }
}

export const toSymphonyConfigEffect = (
  workflowPath: string,
  rawConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<SymphonyConfig, ConfigError, never> =>
  mapSchemaError(decodeRawSections(rawConfig)).pipe(
    Effect.map((decoded) => normalizeConfig(workflowPath, decoded, env)),
  )

export const toSymphonyConfig = (
  workflowPath: string,
  rawConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SymphonyConfig> => Effect.runPromise(toSymphonyConfigEffect(workflowPath, rawConfig, env))

export const validateDispatchConfigEffect = (config: SymphonyConfig): Effect.Effect<void, ConfigError, never> =>
  Effect.gen(function* () {
    if (!config.tracker.kind) {
      return yield* Effect.fail(new ConfigError('unsupported_tracker_kind', 'tracker.kind is required'))
    }
    if (config.tracker.kind !== 'linear') {
      return yield* Effect.fail(
        new ConfigError('unsupported_tracker_kind', `tracker.kind ${config.tracker.kind} is not supported`),
      )
    }
    if (!config.tracker.apiKey) {
      return yield* Effect.fail(new ConfigError('missing_tracker_api_key', 'tracker.api_key is required'))
    }
    if (!config.tracker.projectSlug) {
      return yield* Effect.fail(new ConfigError('missing_tracker_project_slug', 'tracker.project_slug is required'))
    }
    if (!config.codex.command || config.codex.command.trim().length === 0) {
      return yield* Effect.fail(new ConfigError('invalid_codex_command', 'codex.command must be set'))
    }
  })

export const validateDispatchConfig = (config: SymphonyConfig): void => {
  const result = Effect.runSync(Effect.either(validateDispatchConfigEffect(config)))
  if (result._tag === 'Left') {
    throw result.left
  }
}
