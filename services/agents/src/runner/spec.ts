import type { AskForApproval, ReasoningEffort, SandboxMode, ThreadGoalStatus } from '@proompteng/codex'

export const AGENT_RUNNER_SCHEMA_VERSION = 'agents.proompteng.ai/runner/v1'

export type AgentRunnerArtifacts = {
  statusPath?: string
  logPath?: string
  logRetentionSeconds?: number
}

export type AgentRunnerGoal = {
  objective?: string | null
  status?: ThreadGoalStatus | null
  tokenBudget?: number | null
}

export type AgentProviderInputFile = {
  path: string
  content: string
}

export type AgentProviderOutputArtifact = {
  name: string
  path?: string
  key?: string
  url?: string
}

export type AgentProviderSpec = {
  binary?: string
  argsTemplate?: string[]
  envTemplate?: Record<string, string>
  inputFiles?: AgentProviderInputFile[]
  outputArtifacts?: AgentProviderOutputArtifact[]
}

export type CodexAppServerAdapterConfig = {
  binaryPath?: string
  cliConfigOverrides?: string[]
  cwd?: string
  model?: string
  effort?: ReasoningEffort
  sandbox?: SandboxMode
  approval?: AskForApproval
  threadId?: string
  threadConfig?: Record<string, unknown> | null
  experimentalRawEvents?: boolean
  persistExtendedHistory?: boolean
  bootstrapTimeoutMs?: number
  baseInstructions?: string
  developerInstructions?: string
  prompt?: string
  goal?: AgentRunnerGoal
}

export type AgentRunnerAdapter =
  | {
      type: 'codex-app-server'
      codex?: CodexAppServerAdapterConfig
    }
  | {
      type: 'exec'
      exec?: AgentProviderSpec
    }

export type AgentRunnerSpec = {
  schemaVersion?: string
  provider: string
  inputs?: Record<string, unknown>
  payloads?: Record<string, unknown>
  observability?: Record<string, unknown>
  artifacts?: AgentRunnerArtifacts
  goal?: AgentRunnerGoal
  adapter?: AgentRunnerAdapter
  providerSpec?: AgentProviderSpec
}

export type TemplateContext = {
  inputs: Record<string, unknown>
  payloads: Record<string, unknown>
  observability: Record<string, unknown>
  artifacts: Record<string, unknown>
  goal: Record<string, unknown>
  run?: Record<string, unknown>
}

export type ResolvedExecAdapter = {
  type: 'exec'
  provider: AgentProviderSpec & { binary: string }
}

export type ResolvedCodexAppServerAdapter = {
  type: 'codex-app-server'
  codex: CodexAppServerAdapterConfig
}

export type ResolvedAgentRunnerAdapter = ResolvedExecAdapter | ResolvedCodexAppServerAdapter

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export const ensureRecord = (value: Record<string, unknown> | undefined | null): Record<string, unknown> => value ?? {}

export const buildTemplateContext = (spec: AgentRunnerSpec): TemplateContext => ({
  inputs: ensureRecord(spec.inputs),
  payloads: ensureRecord(spec.payloads),
  observability: ensureRecord(spec.observability),
  artifacts: ensureRecord(spec.artifacts as Record<string, unknown> | undefined),
  goal: ensureRecord(spec.goal as Record<string, unknown> | undefined),
})

const resolveTemplateValue = (context: TemplateContext, path: string): string => {
  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
  let current: unknown = context
  for (const segment of segments) {
    if (!isRecord(current)) {
      return ''
    }
    current = current[segment]
  }

  if (current === null || current === undefined) {
    return ''
  }
  if (typeof current === 'string') {
    return current
  }
  if (typeof current === 'number' || typeof current === 'boolean') {
    return String(current)
  }

  try {
    return JSON.stringify(current)
  } catch {
    return ''
  }
}

export const renderTemplate = (template: string, context: TemplateContext): string =>
  template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path) => resolveTemplateValue(context, path))

export const renderTemplateArray = (templates: string[] | undefined, context: TemplateContext): string[] =>
  (templates ?? []).map((template) => renderTemplate(template, context))

export const renderTemplateRecord = (
  templates: Record<string, string> | undefined,
  context: TemplateContext,
): Record<string, string> => {
  if (!templates) {
    return {}
  }
  const entries = Object.entries(templates).map(([key, template]) => [key, renderTemplate(template, context)])
  return Object.fromEntries(entries)
}

export const renderInputFiles = (inputFiles: AgentProviderInputFile[] | undefined, context: TemplateContext) =>
  (inputFiles ?? []).map((file) => ({
    path: renderTemplate(file.path, context),
    content: renderTemplate(file.content, context),
  }))

export const renderOutputArtifacts = (artifacts: AgentProviderOutputArtifact[] | undefined, context: TemplateContext) =>
  (artifacts ?? []).map((artifact) => ({
    ...artifact,
    path: artifact.path ? renderTemplate(artifact.path, context) : artifact.path,
  }))

const mergeProviderSpec = (
  base: AgentProviderSpec | undefined,
  override: AgentProviderSpec | undefined,
): AgentProviderSpec => ({
  binary: override?.binary ?? base?.binary,
  argsTemplate: override?.argsTemplate ?? base?.argsTemplate,
  envTemplate: override?.envTemplate ?? base?.envTemplate,
  inputFiles: override?.inputFiles ?? base?.inputFiles,
  outputArtifacts: override?.outputArtifacts ?? base?.outputArtifacts,
})

const resolveExecProvider = (provider: AgentProviderSpec | undefined): AgentProviderSpec & { binary: string } => {
  if (!provider?.binary) {
    throw new Error('exec agent-runner adapter requires a provider binary')
  }
  return {
    binary: provider.binary,
    argsTemplate: provider.argsTemplate,
    envTemplate: provider.envTemplate,
    inputFiles: provider.inputFiles,
    outputArtifacts: provider.outputArtifacts,
  }
}

export const normalizeRunnerSpec = (spec: AgentRunnerSpec): AgentRunnerSpec => {
  if (spec.schemaVersion && spec.schemaVersion !== AGENT_RUNNER_SCHEMA_VERSION) {
    throw new Error(`Unsupported agent-runner schemaVersion "${spec.schemaVersion}"`)
  }
  if (!spec.provider) {
    throw new Error('agent-runner spec requires provider')
  }
  return {
    ...spec,
    schemaVersion: spec.schemaVersion ?? AGENT_RUNNER_SCHEMA_VERSION,
  }
}

export const resolveAdapter = (rawSpec: AgentRunnerSpec): ResolvedAgentRunnerAdapter => {
  const spec = normalizeRunnerSpec(rawSpec)

  if (spec.adapter?.type === 'codex-app-server') {
    return {
      type: 'codex-app-server',
      codex: spec.adapter.codex ?? {},
    }
  }

  if (spec.adapter?.type === 'exec') {
    return {
      type: 'exec',
      provider: resolveExecProvider(mergeProviderSpec(spec.providerSpec, spec.adapter.exec)),
    }
  }

  if (spec.providerSpec) {
    return {
      type: 'exec',
      provider: resolveExecProvider(spec.providerSpec),
    }
  }

  if (spec.provider === 'codex' || spec.provider === 'codex-runner') {
    return {
      type: 'codex-app-server',
      codex: {},
    }
  }

  throw new Error(`Missing agent-runner adapter for provider "${spec.provider}"`)
}
