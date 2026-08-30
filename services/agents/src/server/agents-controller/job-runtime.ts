import { createHash } from 'node:crypto'

import { asRecord, asString, readNested } from '../primitives'
import { resolveEffectiveServiceAccount } from '../primitives-policy'
import type { createKubernetesClient } from '../kube-types'

import { parseEnvArray, parseEnvRecord, parseOptionalNumber, parseStringList } from './env-config'
import { createImplementationContractTools } from './implementation-contract'
import { resolveParam, resolveParameters, resolveRunGoal } from './run-utils'
import { buildRuntimeRef } from './runtime-resources'
import type { SystemPromptRef } from './system-prompt'
import { renderTemplate } from './template-hash'
import { buildAuthSecretPath, type EnvVar, resolveAuthSecretConfig, type VcsResolution } from './vcs-context'
import { resolveAgentRunnerDefaultsConfig } from './runtime-config'

const MIN_RUNNER_JOB_TTL_SECONDS = 30
const MAX_RUNNER_JOB_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_CODEX_HOME = '/root/.codex'

const normalizeRunnerJobTtlSeconds = (value: number, source: string) => {
  if (!Number.isFinite(value)) return null
  if (value <= 0) return null
  const floored = Math.floor(value)
  if (floored < MIN_RUNNER_JOB_TTL_SECONDS) {
    console.warn(
      `[agents] runner job ttl ${floored}s from ${source} below minimum; clamping to ${MIN_RUNNER_JOB_TTL_SECONDS}s`,
    )
    return MIN_RUNNER_JOB_TTL_SECONDS
  }
  if (floored > MAX_RUNNER_JOB_TTL_SECONDS) {
    console.warn(
      `[agents] runner job ttl ${floored}s from ${source} above maximum; clamping to ${MAX_RUNNER_JOB_TTL_SECONDS}s`,
    )
    return MAX_RUNNER_JOB_TTL_SECONDS
  }
  return floored
}

const resolveRunnerJobTtlSeconds = (runtimeConfig: Record<string, unknown>) => {
  const override = parseOptionalNumber(runtimeConfig.ttlSecondsAfterFinished)
  if (override !== undefined) {
    return normalizeRunnerJobTtlSeconds(override, 'spec.runtime.config.ttlSecondsAfterFinished')
  }
  return normalizeRunnerJobTtlSeconds(
    resolveAgentRunnerDefaultsConfig(process.env).jobTtlSeconds,
    'AGENTS_AGENT_RUNNER_JOB_TTL_SECONDS',
  )
}

const resolveRunnerLogRetentionSeconds = (runtimeConfig: Record<string, unknown>) => {
  const override = parseOptionalNumber(runtimeConfig.logRetentionSeconds)
  if (override !== undefined) {
    return Math.max(0, Math.floor(override))
  }
  return Math.max(0, resolveAgentRunnerDefaultsConfig(process.env).logRetentionSeconds)
}
export const makeName = (base: string, suffix: string) => {
  const normalized = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  const combined = `${normalized}-${suffix}`.replace(/^-+|-+$/g, '')
  if (combined.length <= 63) return combined
  const hash = createHash('sha1').update(combined).digest('hex').slice(0, 8)
  const trimmed = combined.slice(0, 63 - hash.length - 1)
  return `${trimmed}-${hash}`
}

export const normalizeLabelValue = (value: string) => {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')
  const trimmed = normalized.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '')
  if (!trimmed) return 'unknown'
  return trimmed.length <= 63 ? trimmed : trimmed.slice(0, 63)
}

export const buildRunSpecContext = (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown> | null,
  implementation: Record<string, unknown>,
  parameters: Record<string, string>,
  memory: Record<string, unknown> | null,
  vcs?: Record<string, unknown> | null,
) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const agentSpec = asRecord(agent?.spec) ?? {}
  return {
    agentRun: {
      name: asString(metadata.name) ?? '',
      uid: asString(metadata.uid) ?? '',
      namespace: asString(metadata.namespace) ?? '',
    },
    agent: {
      name: asString(readNested(agent, ['metadata', 'name'])) ?? '',
      config: asRecord(agentSpec.config) ?? {},
      env: Array.isArray(agentSpec.env) ? agentSpec.env : [],
    },
    implementation,
    parameters,
    inputs: parameters,
    memory: memory ?? {},
    vcs: vcs ?? {},
  }
}

export const resolveRunnerServiceAccount = (
  runtimeConfig: Record<string, unknown>,
  provider: Record<string, unknown> | null = null,
) =>
  resolveEffectiveServiceAccount(
    { runtime: { config: runtimeConfig } },
    provider,
    resolveAgentRunnerDefaultsConfig(process.env).serviceAccount,
  )

const resolveProviderServiceAccountToken = (provider: Record<string, unknown>) => {
  const raw = asRecord(readNested(provider, ['spec', 'workload', 'serviceAccountToken']))
  if (!raw) return null
  const audience = asString(raw.audience)?.trim()
  const expirationSeconds = parseOptionalNumber(raw.expirationSeconds)
  const mountPath = asString(raw.mountPath)?.trim()
  if (!audience || audience.length > 253)
    throw new Error('AgentProvider workload serviceAccountToken.audience is invalid')
  if (!expirationSeconds || expirationSeconds < 600 || expirationSeconds > 3600) {
    throw new Error('AgentProvider workload serviceAccountToken.expirationSeconds must be between 600 and 3600')
  }
  if (!mountPath || !mountPath.startsWith('/') || mountPath === '/' || mountPath.split('/').includes('..')) {
    throw new Error('AgentProvider workload serviceAccountToken.mountPath must be an absolute non-root path')
  }
  return {
    audience,
    expirationSeconds: Math.trunc(expirationSeconds),
    mountPath: mountPath.replace(/\/+$/, ''),
  }
}

const normalizeResourceQuantityMap = (value: unknown) => {
  const resourceMap = asRecord(value)
  if (!resourceMap) return {}
  return Object.fromEntries(
    Object.entries(resourceMap)
      .map(([key, quantity]) => {
        const normalizedKey = key.trim()
        const normalizedQuantity = asString(quantity)?.trim()
        return normalizedKey && normalizedQuantity ? [normalizedKey, normalizedQuantity] : null
      })
      .filter((entry): entry is [string, string] => entry !== null),
  )
}

const buildJobResources = (
  workload: Record<string, unknown>,
  provider: Record<string, unknown>,
  runtimeConfig: Record<string, unknown>,
) => {
  const defaultResources = resolveAgentRunnerDefaultsConfig(process.env).resources ?? {}
  const providerWorkload = asRecord(readNested(provider, ['spec', 'workload'])) ?? {}
  const providerResources = asRecord(providerWorkload.resources) ?? {}
  const runtimeResources = asRecord(runtimeConfig.resources) ?? {}
  const workloadResources = asRecord(workload.resources) ?? {}
  const requests = {
    ...normalizeResourceQuantityMap(readNested(defaultResources, ['requests'])),
    ...normalizeResourceQuantityMap(readNested(providerResources, ['requests'])),
    ...normalizeResourceQuantityMap(readNested(runtimeResources, ['requests'])),
    ...normalizeResourceQuantityMap(readNested(workloadResources, ['requests'])),
  }
  const limits = {
    ...normalizeResourceQuantityMap(readNested(defaultResources, ['limits'])),
    ...normalizeResourceQuantityMap(readNested(providerResources, ['limits'])),
    ...normalizeResourceQuantityMap(readNested(runtimeResources, ['limits'])),
    ...normalizeResourceQuantityMap(readNested(workloadResources, ['limits'])),
  }
  return {
    ...(Object.keys(requests).length > 0 ? { requests } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  }
}

const resolveProviderSecretEnv = (providerSpec: Record<string, unknown>) => {
  if (Array.isArray(providerSpec.secretEnv)) return providerSpec.secretEnv
  const adapter = asRecord(providerSpec.adapter) ?? {}
  const adapterSecretEnv = adapter.secretEnv
  if (Array.isArray(adapterSecretEnv)) return adapterSecretEnv
  const codexAdapter = asRecord(adapter.codex) ?? {}
  return Array.isArray(codexAdapter.secretEnv) ? codexAdapter.secretEnv : []
}

const buildProviderSecretEnv = (providerSpec: Record<string, unknown>): EnvVar[] => {
  const secretEnv = resolveProviderSecretEnv(providerSpec)
  return secretEnv
    .map((entry): EnvVar | null => {
      const record = asRecord(entry)
      if (!record) return null
      const name = asString(record.name)?.trim()
      const secretName = asString(record.secretName)?.trim()
      const key = asString(record.key)?.trim()
      if (!name || !secretName || !key) return null
      const envVar: EnvVar = {
        name,
        valueFrom: {
          secretKeyRef: {
            name: secretName,
            key,
            ...(record.optional === true ? { optional: true } : {}),
          },
        },
      }
      return envVar
    })
    .filter((entry): entry is EnvVar => entry !== null)
}

const { buildEventPayload } = createImplementationContractTools(resolveParam)

export const renderProviderOutputArtifacts = (
  providerSpec: Record<string, unknown>,
  context: Record<string, unknown>,
): Array<Record<string, unknown>> => {
  const outputArtifacts = Array.isArray(providerSpec.outputArtifacts) ? providerSpec.outputArtifacts : []
  return outputArtifacts
    .map((artifact): Record<string, unknown> | null => {
      const record = asRecord(artifact)
      const name = asString(record?.name)?.trim()
      if (!name) return null
      const path = asString(record?.path)
      const key = asString(record?.key)
      const url = asString(record?.url)
      return {
        name,
        ...(path ? { path: renderTemplate(path, context) } : {}),
        ...(key ? { key: renderTemplate(key, context) } : {}),
        ...(url ? { url: renderTemplate(url, context) } : {}),
      }
    })
    .filter((artifact): artifact is Record<string, unknown> => artifact !== null)
}

export const buildRunSpec = (
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown> | null,
  implementation: Record<string, unknown>,
  parameters: Record<string, string>,
  memory: Record<string, unknown> | null,
  artifacts?: Array<Record<string, unknown>>,
  providerName?: string,
  vcs?: Record<string, unknown> | null,
  systemPrompt?: string | null,
) => {
  const context = buildRunSpecContext(agentRun, agent, implementation, parameters, memory, vcs ?? null)
  const eventPayload = buildEventPayload(implementation, parameters)
  const goal = resolveRunGoal(agentRun)
  return {
    provider: providerName ?? asString(readNested(agent, ['spec', 'providerRef', 'name'])) ?? '',
    agentRun: context.agentRun,
    implementation,
    parameters,
    memory:
      memory == null
        ? null
        : {
            type: asString(readNested(memory, ['spec', 'type'])) ?? 'custom',
            connectionRef: asString(readNested(memory, ['spec', 'connection', 'secretRef', 'name'])) ?? '',
          },
    artifacts: artifacts ?? [],
    ...(vcs ? { vcs } : {}),
    ...(goal ? { goal } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...eventPayload,
  }
}

const buildVolumeSpecs = (workload: Record<string, unknown>) => {
  const volumes = Array.isArray(workload.volumes) ? (workload.volumes as Record<string, unknown>[]) : []
  const volumeSpecs: Array<{ name: string; spec: Record<string, unknown> }> = []
  const volumeMounts: Array<Record<string, unknown>> = []

  for (const volume of volumes) {
    const type = asString(volume.type)
    const name = asString(volume.name)
    const mountPath = asString(volume.mountPath)
    if (!type || !name || !mountPath) continue
    const readOnly = Boolean(volume.readOnly)

    if (type === 'emptyDir') {
      const emptyDir: Record<string, unknown> = {}
      const medium = asString(volume.medium)
      if (medium) emptyDir.medium = medium
      const sizeLimit = asString(volume.sizeLimit)
      if (sizeLimit) emptyDir.sizeLimit = sizeLimit
      volumeSpecs.push({ name, spec: { emptyDir } })
    }

    if (type === 'pvc') {
      const claimName = asString(volume.claimName)
      if (claimName) {
        volumeSpecs.push({ name, spec: { persistentVolumeClaim: { claimName, readOnly } } })
      }
    }

    if (type === 'secret') {
      const secretName = asString(volume.secretName)
      if (secretName) {
        volumeSpecs.push({ name, spec: { secret: { secretName } } })
      }
    }

    volumeMounts.push({ name, mountPath, readOnly })
  }

  return { volumeSpecs, volumeMounts }
}

const hasVolumeMountAtPath = (mounts: readonly Record<string, unknown>[] | undefined, mountPath: string) =>
  (mounts ?? []).some((mount) => asString(mount.mountPath) === mountPath)

const createInputFilesConfigMap = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  agentRun: Record<string, unknown>,
  inputFiles: Array<{ path: string; content: string }>,
  labels: Record<string, string>,
  suffix?: string,
) => {
  if (inputFiles.length === 0) return null
  const metadata = asRecord(agentRun.metadata) ?? {}
  const uid = asString(metadata.uid)
  const runName = asString(metadata.name) ?? 'agentrun'
  const configName = makeName(runName, suffix ? `inputs-${suffix}` : 'inputs')
  const data: Record<string, string> = {}
  inputFiles.forEach((file, index) => {
    data[`input-${index}`] = file.content
  })
  const configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configName,
      namespace,
      labels: { ...labels },
      ...(uid
        ? {
            ownerReferences: [
              {
                apiVersion: 'agents.proompteng.ai/v1alpha1',
                kind: 'AgentRun',
                name: runName,
                uid,
              },
            ],
          }
        : {}),
    },
    data,
  }
  await kube.apply(configMap)
  return { name: configName, files: inputFiles }
}

const createRunSpecConfigMap = async (
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  agentRun: Record<string, unknown>,
  runSpec: Record<string, unknown>,
  labels: Record<string, string>,
  suffix?: string,
  agentRunnerSpec?: Record<string, unknown>,
) => {
  const metadata = asRecord(agentRun.metadata) ?? {}
  const uid = asString(metadata.uid)
  const runName = asString(metadata.name) ?? 'agentrun'
  const configName = makeName(runName, suffix ? `spec-${suffix}` : 'spec')
  const data: Record<string, string> = {
    'run.json': JSON.stringify(runSpec, null, 2),
  }
  if (agentRunnerSpec) {
    data['agent-runner.json'] = JSON.stringify(agentRunnerSpec, null, 2)
  }
  const configMap = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: configName,
      namespace,
      labels: { ...labels },
      ...(uid
        ? {
            ownerReferences: [
              {
                apiVersion: 'agents.proompteng.ai/v1alpha1',
                kind: 'AgentRun',
                name: runName,
                uid,
              },
            ],
          }
        : {}),
    },
    data,
  }
  await kube.apply(configMap)
  return configName
}

const isAgentRunnerBinary = (binary: string | null) =>
  !binary || binary === '/usr/local/bin/agent-runner' || binary.endsWith('/agent-runner')

const resolveProviderAdapterType = (providerSpec: Record<string, unknown>): 'codex-app-server' | 'exec' => {
  const explicitType = asString(readNested(providerSpec, ['adapter', 'type']))
  if (explicitType === 'exec') return 'exec'
  if (explicitType === 'codex-app-server') return 'codex-app-server'
  return isAgentRunnerBinary(asString(providerSpec.binary)) ? 'codex-app-server' : 'exec'
}

const sanitizeProviderAdapterForRunner = (adapter: Record<string, unknown>) => {
  const { secretEnv: _secretEnv, codex, ...rest } = adapter
  const codexRecord = asRecord(codex)
  if (!codexRecord) return rest
  const { secretEnv: _codexSecretEnv, ...codexRest } = codexRecord
  return {
    ...rest,
    codex: codexRest,
  }
}

const DEFAULT_CODEX_APP_SERVER_MODEL = 'gpt-5.6-sol'
const DEFAULT_CODEX_APP_SERVER_EFFORT = 'high'
const DEFAULT_CODEX_APP_SERVER_SANDBOX = 'danger-full-access'
const DEFAULT_CODEX_APP_SERVER_APPROVAL = 'never'
const DEFAULT_CODEX_APP_SERVER_THREAD_CONFIG = { mcp_servers: {}, web_search: 'live' }

const compactRecord = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))

const buildRunnerTemplateContext = (runSpec: Record<string, unknown>, parameters: Record<string, string>) => ({
  ...runSpec,
  run: runSpec,
  parameters,
  inputs: parameters,
})

const renderOptionalString = (value: unknown, context: Record<string, unknown>) => {
  const text = asString(value)
  if (text == null) return undefined
  return renderTemplate(text, context)
}

const renderOptionalStringArray = (value: unknown, context: Record<string, unknown>) => {
  if (!Array.isArray(value)) return undefined
  return value.map((entry) => renderTemplate(String(entry), context))
}

const copyBoolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined)

const resolveCodexThreadConfig = (value: unknown) => {
  if (value === null) return null
  return asRecord(value) ?? DEFAULT_CODEX_APP_SERVER_THREAD_CONFIG
}

const resolveCodexPrompt = (
  codex: Record<string, unknown>,
  runSpec: Record<string, unknown>,
  context: Record<string, unknown>,
) => {
  const renderedPrompt = renderOptionalString(codex.prompt, context)?.trim()
  if (renderedPrompt) return renderedPrompt

  const candidates = [
    runSpec.prompt,
    readNested(runSpec, ['implementation', 'text']),
    readNested(runSpec, ['implementation', 'summary']),
    runSpec.issueBody,
    readNested(runSpec, ['event', 'body']),
  ]
  for (const candidate of candidates) {
    const text = asString(candidate)?.trim()
    if (text) return text
  }
  return JSON.stringify(runSpec, null, 2)
}

const buildCodexAppServerAdapterForRunner = (
  runSpec: Record<string, unknown>,
  parameters: Record<string, string>,
  providerSpec: Record<string, unknown>,
  options: {
    systemPromptPath?: string
    systemPromptExpectedHash?: string | null
  } = {},
) => {
  const explicitAdapter = asRecord(providerSpec.adapter) ?? {}
  const codex = asRecord(explicitAdapter.codex) ?? {}
  const context = buildRunnerTemplateContext(runSpec, parameters)
  const renderedBaseInstructions = renderOptionalString(codex.baseInstructions, context)
  const bootstrapTimeoutMs = parseOptionalNumber(codex.bootstrapTimeoutMs)

  return {
    type: 'codex-app-server',
    codex: compactRecord({
      binaryPath: renderOptionalString(codex.binaryPath, context),
      cliConfigOverrides: renderOptionalStringArray(codex.cliConfigOverrides, context),
      cwd: renderOptionalString(codex.cwd, context),
      model: renderOptionalString(codex.model, context) ?? DEFAULT_CODEX_APP_SERVER_MODEL,
      effort: renderOptionalString(codex.effort, context) ?? DEFAULT_CODEX_APP_SERVER_EFFORT,
      sandbox: renderOptionalString(codex.sandbox, context) ?? DEFAULT_CODEX_APP_SERVER_SANDBOX,
      approval: renderOptionalString(codex.approval, context) ?? DEFAULT_CODEX_APP_SERVER_APPROVAL,
      threadId: renderOptionalString(codex.threadId, context),
      threadConfig: resolveCodexThreadConfig(codex.threadConfig),
      experimentalRawEvents: copyBoolean(codex.experimentalRawEvents),
      persistExtendedHistory: copyBoolean(codex.persistExtendedHistory),
      bootstrapTimeoutMs,
      baseInstructions: renderedBaseInstructions,
      developerInstructions: renderOptionalString(codex.developerInstructions, context),
      prompt: resolveCodexPrompt(codex, runSpec, context),
      goal: asRecord(codex.goal) ?? undefined,
      systemPromptPath: options.systemPromptPath,
      systemPromptExpectedHash: options.systemPromptExpectedHash ?? undefined,
    }),
  }
}

const buildAgentRunnerSpec = (
  runSpec: Record<string, unknown>,
  parameters: Record<string, string>,
  providerName: string,
  logRetentionSeconds: number,
  providerSpec: Record<string, unknown>,
  options: {
    systemPromptPath?: string
    systemPromptExpectedHash?: string | null
  } = {},
) => {
  const explicitAdapter = asRecord(providerSpec.adapter)
  const binary = asString(providerSpec.binary)
  const outputArtifacts = Array.isArray(providerSpec.outputArtifacts) ? providerSpec.outputArtifacts : []
  const defaultAdapter =
    resolveProviderAdapterType(providerSpec) === 'exec'
      ? {
          type: 'exec',
          exec: {
            binary,
            ...(Array.isArray(providerSpec.argsTemplate) ? { argsTemplate: providerSpec.argsTemplate } : {}),
            ...(asRecord(providerSpec.envTemplate) ? { envTemplate: providerSpec.envTemplate } : {}),
            ...(Array.isArray(providerSpec.inputFiles) ? { inputFiles: providerSpec.inputFiles } : {}),
            ...(Array.isArray(providerSpec.outputArtifacts) ? { outputArtifacts: providerSpec.outputArtifacts } : {}),
          },
        }
      : buildCodexAppServerAdapterForRunner(runSpec, parameters, providerSpec, options)
  const adapter =
    resolveProviderAdapterType(providerSpec) === 'codex-app-server'
      ? buildCodexAppServerAdapterForRunner(runSpec, parameters, providerSpec, options)
      : explicitAdapter
        ? sanitizeProviderAdapterForRunner(explicitAdapter)
        : defaultAdapter

  return {
    schemaVersion: 'agents.proompteng.ai/runner/v1',
    provider: providerName,
    inputs: parameters,
    ...(asRecord(runSpec.goal) ? { goal: runSpec.goal } : {}),
    payloads: {
      eventFilePath: '/workspace/run.json',
    },
    artifacts: {
      statusPath: '/workspace/.agent/status.json',
      logPath: '/workspace/.agent/runner.log',
      logRetentionSeconds,
    },
    ...(outputArtifacts.length > 0 ? { providerSpec: { outputArtifacts } } : {}),
    adapter,
  }
}

export const applyJobTtlAfterStatus = async (
  kube: ReturnType<typeof createKubernetesClient>,
  job: Record<string, unknown>,
  namespace: string,
  runtimeConfig: Record<string, unknown>,
) => {
  const ttlSeconds = resolveRunnerJobTtlSeconds(runtimeConfig)
  if (ttlSeconds === null) return
  const name = asString(readNested(job, ['metadata', 'name'])) ?? ''
  if (!name) return
  const currentTtl = parseOptionalNumber(readNested(job, ['spec', 'ttlSecondsAfterFinished']))
  if (currentTtl === ttlSeconds) return
  await kube.patch('job', name, namespace, { spec: { ttlSecondsAfterFinished: ttlSeconds } })
}

export type SubmitJobRunOptions = {
  nameSuffix?: string
  labels?: Record<string, string>
  workload?: Record<string, unknown>
  parameters?: Record<string, string>
  runtimeConfig?: Record<string, unknown>
  vcs?: VcsResolution
  systemPrompt?: string | null
  systemPromptHash?: string | null
  systemPromptRef?: SystemPromptRef | null
}

const getExistingAgentRunJobRef = async (
  kube: ReturnType<typeof createKubernetesClient>,
  jobName: string,
  namespace: string,
  runName: string,
  runtimeType: 'job' | 'workflow',
) => {
  const existing = await kube.get('job', jobName, namespace)
  if (!existing) return null

  const labels = asRecord(readNested(existing, ['metadata', 'labels'])) ?? {}
  const existingRunName = asString(labels['agents.proompteng.ai/agent-run'])
  if (existingRunName !== runName) {
    throw new Error(
      `job ${jobName} already exists in ${namespace} but belongs to AgentRun ${existingRunName ?? 'unknown'}`,
    )
  }

  return buildRuntimeRef(runtimeType, jobName, namespace, { uid: asString(readNested(existing, ['metadata', 'uid'])) })
}

const isImmutableJobApplyError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('job.batch') && normalized.includes('field is immutable')
}

const isKubeNotFoundMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('notfound') || normalized.includes(' not found')
}

export const getMountedConfigMapNames = (job: Record<string, unknown>) => {
  const volumes = readNested(job, ['spec', 'template', 'spec', 'volumes'])
  if (!Array.isArray(volumes)) return []

  const names = new Set<string>()
  for (const volume of volumes) {
    const record = asRecord(volume)
    const configMap = asRecord(record?.configMap)
    const name = asString(configMap?.name)?.trim()
    if (name) names.add(name)
  }

  return [...names].sort()
}

export const verifyJobConfigMaps = async (
  kube: Pick<ReturnType<typeof createKubernetesClient>, 'get'>,
  job: Record<string, unknown>,
  namespace: string,
): Promise<{ ok: true; names: string[] } | { ok: false; names: string[]; missing: string[] }> => {
  const names = getMountedConfigMapNames(job)
  if (names.length === 0) return { ok: true, names }

  const missing: string[] = []
  for (const name of names) {
    try {
      const configMap = await kube.get('configmap', name, namespace)
      if (!configMap) missing.push(name)
    } catch (error) {
      if (isKubeNotFoundMessage(error)) {
        missing.push(name)
        continue
      }
      throw error
    }
  }

  return missing.length === 0 ? { ok: true, names } : { ok: false, names, missing }
}

export const submitJobRun = async (
  kube: ReturnType<typeof createKubernetesClient>,
  agentRun: Record<string, unknown>,
  agent: Record<string, unknown>,
  provider: Record<string, unknown>,
  implementation: Record<string, unknown>,
  memory: Record<string, unknown> | null,
  namespace: string,
  workloadImage: string,
  runtimeType: 'job' | 'workflow',
  options: SubmitJobRunOptions = {},
) => {
  const workload = options.workload ?? asRecord(readNested(agentRun, ['spec', 'workload'])) ?? {}
  if (!workloadImage) {
    throw new Error(
      'spec.workload.image, AgentProvider.spec.workload.image, or AGENTS_AGENT_RUNNER_IMAGE is required for job runtime',
    )
  }

  const providerSpec = asRecord(provider.spec) ?? {}
  const inputFiles = Array.isArray(providerSpec.inputFiles) ? providerSpec.inputFiles : []
  const binary = asString(providerSpec.binary) ?? '/usr/local/bin/agent-runner'
  const providerName = asString(readNested(provider, ['metadata', 'name'])) ?? ''

  const parameters = options.parameters ?? resolveParameters(agentRun)
  const vcsContext = options.vcs?.context ?? null
  const vcsRuntime = options.vcs?.runtime ?? null
  const context = buildRunSpecContext(agentRun, agent, implementation, parameters, memory, vcsContext)
  const outputArtifacts = renderProviderOutputArtifacts(providerSpec, context)

  const argsTemplate = Array.isArray(providerSpec.argsTemplate) ? providerSpec.argsTemplate : []
  const args = argsTemplate.map((arg) => renderTemplate(String(arg), context))

  const envTemplate = asRecord(providerSpec.envTemplate) ?? {}
  const env: EnvVar[] = Object.entries(envTemplate).map(([key, value]) => ({
    name: key,
    value: renderTemplate(String(value), context),
  }))
  env.push(...buildProviderSecretEnv(providerSpec))
  if (providerName) {
    env.push({ name: 'AGENT_PROVIDER', value: providerName })
  }
  if (vcsRuntime?.env?.length) {
    env.push(...vcsRuntime.env)
  }

  const runSpec = buildRunSpec(
    agentRun,
    agent,
    implementation,
    parameters,
    memory,
    outputArtifacts,
    providerName,
    vcsContext,
    options.systemPrompt ?? null,
  )
  const runSecrets = parseStringList(readNested(agentRun, ['spec', 'secrets']))
  const envFrom = runSecrets.map((name) => ({ secretRef: { name } }))
  const authSecret = resolveAuthSecretConfig()

  const inputEntries = inputFiles
    .map((file: Record<string, unknown>) => ({
      path: asString(file.path) ?? '',
      content: asString(file.content) ?? '',
    }))
    .filter((file) => file.path && file.content)

  const runtimeConfig = options.runtimeConfig ?? asRecord(readNested(agentRun, ['spec', 'runtime', 'config'])) ?? {}
  const logRetentionSeconds = resolveRunnerLogRetentionSeconds(runtimeConfig)
  const backoffLimit = (() => {
    const explicit = parseOptionalNumber(runtimeConfig.backoffLimit)
    if (explicit !== undefined) {
      return Math.max(0, Math.trunc(explicit))
    }
    const envValue = resolveAgentRunnerDefaultsConfig(process.env).backoffLimit
    if (envValue != null) {
      return Math.max(0, Math.trunc(envValue))
    }
    // Avoid retry loops for side-effecting agent runs (e.g. PR creation). Prefer workflow-level retries.
    return 0
  })()
  const agentRunnerSpec = providerName
    ? buildAgentRunnerSpec(runSpec, parameters, providerName, logRetentionSeconds, providerSpec, {
        ...(options.systemPromptRef ? { systemPromptPath: '/workspace/.codex/system-prompt.txt' } : {}),
        systemPromptExpectedHash: options.systemPromptHash,
      })
    : null
  const serviceAccount = resolveRunnerServiceAccount(runtimeConfig, provider)
  const serviceAccountToken = resolveProviderServiceAccountToken(provider)
  const runnerDefaultsConfig = resolveAgentRunnerDefaultsConfig(process.env)
  const nodeSelector =
    asRecord(runtimeConfig.nodeSelector) ??
    runnerDefaultsConfig.nodeSelector ??
    parseEnvRecord('AGENTS_AGENT_RUNNER_NODE_SELECTOR')
  const tolerations =
    (Array.isArray(runtimeConfig.tolerations) ? runtimeConfig.tolerations : null) ??
    runnerDefaultsConfig.tolerations ??
    parseEnvArray('AGENTS_AGENT_RUNNER_TOLERATIONS')
  const topologySpreadConstraints =
    (Array.isArray(runtimeConfig.topologySpreadConstraints) ? runtimeConfig.topologySpreadConstraints : null) ??
    runnerDefaultsConfig.topologySpreadConstraints ??
    parseEnvArray('AGENTS_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS')
  const affinity =
    asRecord(runtimeConfig.affinity) ?? runnerDefaultsConfig.affinity ?? parseEnvRecord('AGENTS_AGENT_RUNNER_AFFINITY')
  const podSecurityContext =
    asRecord(runtimeConfig.podSecurityContext) ??
    runnerDefaultsConfig.podSecurityContext ??
    parseEnvRecord('AGENTS_AGENT_RUNNER_POD_SECURITY_CONTEXT')
  const priorityClassName = asString(runtimeConfig.priorityClassName) ?? runnerDefaultsConfig.priorityClassName
  const schedulerName = asString(runtimeConfig.schedulerName) ?? runnerDefaultsConfig.schedulerName
  const imagePullSecrets = (() => {
    const candidates = Array.isArray(runtimeConfig.imagePullSecrets)
      ? runtimeConfig.imagePullSecrets
      : (runnerDefaultsConfig.imagePullSecrets ?? parseEnvArray('AGENTS_AGENT_RUNNER_IMAGE_PULL_SECRETS'))
    if (!candidates) return null
    const resolved = candidates
      .map((entry) => {
        if (typeof entry === 'string') {
          const trimmed = entry.trim()
          return trimmed ? { name: trimmed } : null
        }
        const record = asRecord(entry)
        const name = record ? asString(record.name) : null
        return name ? { name } : null
      })
      .filter((entry): entry is { name: string } => Boolean(entry))
    return resolved.length > 0 ? resolved : null
  })()
  const metadata = asRecord(agentRun.metadata) ?? {}
  const runName = asString(metadata.name) ?? 'agentrun'
  const runUid = asString(metadata.uid)
  const jobName = makeName(runName, options.nameSuffix ?? 'job')
  const existingJobRef = await getExistingAgentRunJobRef(kube, jobName, namespace, runName, runtimeType)

  const agentName = asString(readNested(agent, ['metadata', 'name']))
  const implName = asString(readNested(agentRun, ['spec', 'implementationSpecRef', 'name']))
  const labels: Record<string, string> = {
    'agents.proompteng.ai/agent-run': runName,
  }
  if (agentName) {
    labels['agents.proompteng.ai/agent'] = normalizeLabelValue(agentName)
  }
  if (providerName) {
    labels['agents.proompteng.ai/provider'] = normalizeLabelValue(providerName)
  }
  if (implName) {
    labels['agents.proompteng.ai/implementation'] = normalizeLabelValue(implName)
  }

  const mergedLabels = { ...labels, ...options.labels }
  const inputsConfig = await createInputFilesConfigMap(
    kube,
    namespace,
    agentRun,
    inputEntries,
    mergedLabels,
    options.nameSuffix,
  )
  const specConfigName = await createRunSpecConfigMap(
    kube,
    namespace,
    agentRun,
    runSpec,
    mergedLabels,
    options.nameSuffix,
    agentRunnerSpec ?? undefined,
  )
  if (existingJobRef) return existingJobRef

  const { volumeSpecs, volumeMounts } = buildVolumeSpecs(workload)

  const configVolumeMounts = [] as Record<string, unknown>[]
  const volumes = [...volumeSpecs]

  if (inputsConfig) {
    const volumeName = makeName(inputsConfig.name, 'vol')
    volumes.push({ name: volumeName, spec: { configMap: { name: inputsConfig.name } } })
    inputsConfig.files.forEach((file, index) => {
      configVolumeMounts.push({
        name: volumeName,
        mountPath: file.path,
        subPath: `input-${index}`,
      })
    })
  }

  const specVolumeName = makeName(specConfigName, 'vol')
  volumes.push({ name: specVolumeName, spec: { configMap: { name: specConfigName } } })
  configVolumeMounts.push({ name: specVolumeName, mountPath: '/workspace/run.json', subPath: 'run.json' })
  if (agentRunnerSpec) {
    configVolumeMounts.push({
      name: specVolumeName,
      mountPath: '/workspace/agent-runner.json',
      subPath: 'agent-runner.json',
    })
  }

  const systemPromptRef = options.systemPromptRef ?? null
  if (systemPromptRef) {
    const volumeName = makeName(runName, options.nameSuffix ? `system-prompt-${options.nameSuffix}` : 'system-prompt')
    const item = { key: systemPromptRef.key, path: 'system-prompt.txt' }
    volumes.push({
      name: volumeName,
      spec:
        systemPromptRef.kind === 'Secret'
          ? {
              secret: {
                secretName: systemPromptRef.name,
                items: [item],
              },
            }
          : {
              configMap: {
                name: systemPromptRef.name,
                items: [item],
              },
            },
    })
    configVolumeMounts.push({
      name: volumeName,
      mountPath: '/workspace/.codex',
      readOnly: true,
    })
  }

  const codexHomePath = authSecret?.mountPath ?? DEFAULT_CODEX_HOME
  const codexHomeAlreadyMounted =
    hasVolumeMountAtPath(volumeMounts, codexHomePath) || hasVolumeMountAtPath(vcsRuntime?.volumeMounts, codexHomePath)
  if (authSecret && !codexHomeAlreadyMounted) {
    const codexHomeVolumeName = makeName(
      runName,
      authSecret
        ? options.nameSuffix
          ? `auth-home-${options.nameSuffix}`
          : 'auth-home'
        : options.nameSuffix
          ? `codex-home-${options.nameSuffix}`
          : 'codex-home',
    )
    volumes.push({
      name: codexHomeVolumeName,
      spec: { emptyDir: {} },
    })
    configVolumeMounts.push({
      name: codexHomeVolumeName,
      mountPath: codexHomePath,
    })
  }

  if (authSecret) {
    const authSecretVolumeName = makeName(
      runName,
      options.nameSuffix ? `auth-secret-${options.nameSuffix}` : 'auth-secret',
    )
    volumes.push({
      name: authSecretVolumeName,
      spec: {
        secret: {
          secretName: authSecret.name,
          items: [{ key: authSecret.key, path: authSecret.key }],
        },
      },
    })
    configVolumeMounts.push({
      name: authSecretVolumeName,
      mountPath: buildAuthSecretPath(authSecret),
      subPath: authSecret.key,
      readOnly: true,
    })
  }

  if (vcsRuntime?.volumes?.length) {
    for (const volume of vcsRuntime.volumes) {
      volumes.push(volume)
    }
  }
  if (vcsRuntime?.volumeMounts?.length) {
    configVolumeMounts.push(...vcsRuntime.volumeMounts)
  }

  if (serviceAccountToken) {
    if (
      hasVolumeMountAtPath(volumeMounts, serviceAccountToken.mountPath) ||
      hasVolumeMountAtPath(configVolumeMounts, serviceAccountToken.mountPath)
    ) {
      throw new Error(`projected service account token mountPath ${serviceAccountToken.mountPath} is already in use`)
    }
    const identityVolumeName = makeName(providerName || runName, 'mcp-identity')
    volumes.push({
      name: identityVolumeName,
      spec: {
        projected: {
          defaultMode: 420,
          sources: [
            {
              serviceAccountToken: {
                audience: serviceAccountToken.audience,
                expirationSeconds: serviceAccountToken.expirationSeconds,
                path: 'token',
              },
            },
          ],
        },
      },
    })
    configVolumeMounts.push({
      name: identityVolumeName,
      mountPath: serviceAccountToken.mountPath,
      readOnly: true,
    })
    env.push({
      name: 'AGENTS_MCP_IDENTITY_TOKEN_PATH',
      value: `${serviceAccountToken.mountPath}/token`,
    })
  }

  const jobPodSpec: Record<string, unknown> = {
    serviceAccountName: serviceAccount,
    ...(serviceAccountToken ? { automountServiceAccountToken: false } : {}),
    restartPolicy: 'Never',
    containers: [
      {
        name: 'agent-runner',
        image: workloadImage,
        command: [binary],
        args,
        env: [
          { name: 'AGENT_RUN_SPEC', value: '/workspace/run.json' },
          { name: 'AGENT_RUNNER_SPEC_PATH', value: '/workspace/agent-runner.json' },
          { name: 'CODEX_HOME', value: codexHomePath },
          ...(authSecret ? [{ name: 'CODEX_AUTH', value: buildAuthSecretPath(authSecret) }] : []),
          ...env,
          ...(systemPromptRef
            ? [{ name: 'CODEX_SYSTEM_PROMPT_PATH', value: '/workspace/.codex/system-prompt.txt' }]
            : []),
          ...(options.systemPromptHash
            ? [
                { name: 'CODEX_SYSTEM_PROMPT_EXPECTED_HASH', value: options.systemPromptHash },
                { name: 'CODEX_SYSTEM_PROMPT_REQUIRED', value: 'true' },
              ]
            : []),
        ],
        envFrom: envFrom.length > 0 ? envFrom : undefined,
        resources: buildJobResources(workload, provider, runtimeConfig),
        volumeMounts: [...volumeMounts, ...configVolumeMounts],
        terminationMessagePath: '/workspace/.agent/status.json',
        terminationMessagePolicy: 'File',
      },
    ],
    volumes: volumes.map((volume) => ({ name: volume.name, ...volume.spec })),
  }

  if (nodeSelector && Object.keys(nodeSelector).length > 0) {
    jobPodSpec.nodeSelector = nodeSelector
  }
  if (tolerations && tolerations.length > 0) {
    jobPodSpec.tolerations = tolerations
  }
  if (topologySpreadConstraints && topologySpreadConstraints.length > 0) {
    jobPodSpec.topologySpreadConstraints = topologySpreadConstraints
  }
  if (affinity && Object.keys(affinity).length > 0) {
    jobPodSpec.affinity = affinity
  }
  if (podSecurityContext && Object.keys(podSecurityContext).length > 0) {
    jobPodSpec.securityContext = podSecurityContext
  }
  if (imagePullSecrets && imagePullSecrets.length > 0) {
    jobPodSpec.imagePullSecrets = imagePullSecrets
  }
  if (priorityClassName) {
    jobPodSpec.priorityClassName = priorityClassName
  }
  if (schedulerName) {
    jobPodSpec.schedulerName = schedulerName
  }

  const jobResource = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace,
      labels: mergedLabels,
      ...(runUid
        ? {
            ownerReferences: [
              {
                apiVersion: 'agents.proompteng.ai/v1alpha1',
                kind: 'AgentRun',
                name: runName,
                uid: runUid,
              },
            ],
          }
        : {}),
    },
    spec: {
      backoffLimit,
      template: {
        metadata: {
          labels: mergedLabels,
        },
        spec: jobPodSpec,
      },
    },
  }

  let applied: Record<string, unknown>
  try {
    applied = await kube.apply(jobResource)
  } catch (error) {
    if (!isImmutableJobApplyError(error)) throw error
    const existingAfterConflict = await getExistingAgentRunJobRef(kube, jobName, namespace, runName, runtimeType)
    if (existingAfterConflict) return existingAfterConflict
    throw error
  }
  return buildRuntimeRef(runtimeType, jobName, namespace, { uid: asString(readNested(applied, ['metadata', 'uid'])) })
}
