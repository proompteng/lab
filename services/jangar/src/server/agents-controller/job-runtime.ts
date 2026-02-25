import { createHash } from 'node:crypto'

import { asRecord, asString, readNested } from '~/server/primitives-http'
import type { createKubernetesClient } from '~/server/primitives-kube'

import { parseEnvArray, parseEnvRecord, parseOptionalNumber, parseStringList } from './env-config'
import { createImplementationContractTools } from './implementation-contract'
import { resolveParam, resolveParameters } from './run-utils'
import { buildRuntimeRef } from './runtime-resources'
import type { SystemPromptRef } from './system-prompt'
import { renderTemplate } from './template-hash'
import {
  buildAuthSecretPath,
  collectBlockedSecrets,
  type EnvVar,
  resolveAuthSecretConfig,
  secretHasKey,
  type VcsResolution,
} from './vcs-context'

const DEFAULT_RUNNER_JOB_TTL_SECONDS = 600
const DEFAULT_RUNNER_LOG_RETENTION_SECONDS = 7 * 24 * 60 * 60
const MIN_RUNNER_JOB_TTL_SECONDS = 30
const MAX_RUNNER_JOB_TTL_SECONDS = 7 * 24 * 60 * 60

const normalizeRunnerJobTtlSeconds = (value: number, source: string) => {
  if (!Number.isFinite(value)) return null
  if (value <= 0) return null
  const floored = Math.floor(value)
  if (floored < MIN_RUNNER_JOB_TTL_SECONDS) {
    console.warn(
      `[jangar] runner job ttl ${floored}s from ${source} below minimum; clamping to ${MIN_RUNNER_JOB_TTL_SECONDS}s`,
    )
    return MIN_RUNNER_JOB_TTL_SECONDS
  }
  if (floored > MAX_RUNNER_JOB_TTL_SECONDS) {
    console.warn(
      `[jangar] runner job ttl ${floored}s from ${source} above maximum; clamping to ${MAX_RUNNER_JOB_TTL_SECONDS}s`,
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
  const envDefault = parseOptionalNumber(process.env.JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS)
  if (envDefault !== undefined) {
    return normalizeRunnerJobTtlSeconds(envDefault, 'JANGAR_AGENT_RUNNER_JOB_TTL_SECONDS')
  }
  return normalizeRunnerJobTtlSeconds(DEFAULT_RUNNER_JOB_TTL_SECONDS, 'default')
}

const resolveRunnerLogRetentionSeconds = (runtimeConfig: Record<string, unknown>) => {
  const override = parseOptionalNumber(runtimeConfig.logRetentionSeconds)
  if (override !== undefined) {
    return Math.max(0, Math.floor(override))
  }
  const envDefault = parseOptionalNumber(process.env.JANGAR_AGENT_RUNNER_LOG_RETENTION_SECONDS)
  if (envDefault !== undefined) {
    return Math.max(0, Math.floor(envDefault))
  }
  return DEFAULT_RUNNER_LOG_RETENTION_SECONDS
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

const buildRunSpecContext = (
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
    memory: memory ?? {},
    vcs: vcs ?? {},
  }
}

export const resolveRunnerServiceAccount = (runtimeConfig: Record<string, unknown>) =>
  asString(runtimeConfig.serviceAccount) ?? asString(process.env.JANGAR_AGENT_RUNNER_SERVICE_ACCOUNT)

const buildJobResources = (workload: Record<string, unknown>) => {
  const resources = asRecord(workload.resources) ?? {}
  const requests = asRecord(resources.requests) ?? {}
  const limits = asRecord(resources.limits) ?? {}
  return {
    requests,
    limits,
  }
}

const { buildEventPayload } = createImplementationContractTools(resolveParam)

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

const buildAgentRunnerSpec = (
  _runSpec: Record<string, unknown>,
  parameters: Record<string, string>,
  providerName: string,
  logRetentionSeconds: number,
) => ({
  provider: providerName,
  inputs: parameters,
  payloads: {
    eventFilePath: '/workspace/run.json',
  },
  artifacts: {
    statusPath: '/workspace/.agent/status.json',
    logPath: '/workspace/.agent/runner.log',
    logRetentionSeconds,
  },
})

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
    throw new Error('spec.workload.image, JANGAR_AGENT_RUNNER_IMAGE, or JANGAR_AGENT_IMAGE is required for job runtime')
  }

  const providerSpec = asRecord(provider.spec) ?? {}
  const inputFiles = Array.isArray(providerSpec.inputFiles) ? providerSpec.inputFiles : []
  const outputArtifacts = Array.isArray(providerSpec.outputArtifacts) ? providerSpec.outputArtifacts : []
  const binary = asString(providerSpec.binary) ?? '/usr/local/bin/agent-runner'
  const providerName = asString(readNested(provider, ['metadata', 'name'])) ?? ''

  const parameters = options.parameters ?? resolveParameters(agentRun)
  const vcsContext = options.vcs?.context ?? null
  const vcsRuntime = options.vcs?.runtime ?? null
  const context = buildRunSpecContext(agentRun, agent, implementation, parameters, memory, vcsContext)

  const argsTemplate = Array.isArray(providerSpec.argsTemplate) ? providerSpec.argsTemplate : []
  const args = argsTemplate.map((arg) => renderTemplate(String(arg), context))

  const envTemplate = asRecord(providerSpec.envTemplate) ?? {}
  const env: EnvVar[] = Object.entries(envTemplate).map(([key, value]) => ({
    name: key,
    value: renderTemplate(String(value), context),
  }))
  if (providerName) {
    env.push({ name: 'AGENT_PROVIDER', value: providerName })
  }
  if (vcsRuntime?.env?.length) {
    env.push(...vcsRuntime.env)
  }

  // Allow the controller to inject NATS user/pass for runner pods without requiring every AgentRun
  // to carry credentials. This is used by codex tooling like `codex-nats-publish`.
  const runnerNatsAuthSecretName = process.env.JANGAR_AGENT_RUNNER_NATS_AUTH_SECRET_NAME?.trim()
  if (runnerNatsAuthSecretName) {
    const alreadyHasUser = env.some((item) => item.name === 'NATS_USER')
    const alreadyHasPass = env.some((item) => item.name === 'NATS_PASSWORD')
    if (!alreadyHasUser || !alreadyHasPass) {
      const usernameKey = process.env.JANGAR_AGENT_RUNNER_NATS_AUTH_USERNAME_KEY?.trim() || 'username'
      const passwordKey = process.env.JANGAR_AGENT_RUNNER_NATS_AUTH_PASSWORD_KEY?.trim() || 'password'

      const security = asRecord(readNested(agent, ['spec', 'security'])) ?? {}
      const allowedSecrets = parseStringList(security.allowedSecrets)
      const blocked = collectBlockedSecrets([runnerNatsAuthSecretName])
      const allowlisted = allowedSecrets.length === 0 || allowedSecrets.includes(runnerNatsAuthSecretName)

      // Only inject if:
      // - secret isn't blocked by controller policy
      // - Agent allowlist allows it (or no allowlist is configured)
      // - secret exists and has both keys (avoid CreateContainerConfigError on missing secrets/keys)
      if (blocked.length === 0 && allowlisted) {
        const secret = await kube.get('secret', runnerNatsAuthSecretName, namespace)
        if (
          secret &&
          secretHasKey(secret, usernameKey) &&
          secretHasKey(secret, passwordKey) &&
          (!alreadyHasUser || !alreadyHasPass)
        ) {
          if (!alreadyHasUser) {
            env.push({
              name: 'NATS_USER',
              valueFrom: {
                secretKeyRef: { name: runnerNatsAuthSecretName, key: usernameKey },
              },
            })
          }
          if (!alreadyHasPass) {
            env.push({
              name: 'NATS_PASSWORD',
              valueFrom: {
                secretKeyRef: { name: runnerNatsAuthSecretName, key: passwordKey },
              },
            })
          }
        }
      }
    }
  }

  const runSpec = buildRunSpec(
    agentRun,
    agent,
    implementation,
    parameters,
    memory,
    Array.isArray(outputArtifacts) ? outputArtifacts : [],
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
    const envValue = parseOptionalNumber(process.env.JANGAR_AGENT_RUNNER_BACKOFF_LIMIT)
    if (envValue !== undefined) {
      return Math.max(0, Math.trunc(envValue))
    }
    // Avoid retry loops for side-effecting agent runs (e.g. PR creation). Prefer workflow-level retries.
    return 0
  })()
  const agentRunnerSpec = providerName
    ? buildAgentRunnerSpec(runSpec, parameters, providerName, logRetentionSeconds)
    : null
  const serviceAccount = resolveRunnerServiceAccount(runtimeConfig)
  const nodeSelector = asRecord(runtimeConfig.nodeSelector) ?? parseEnvRecord('JANGAR_AGENT_RUNNER_NODE_SELECTOR')
  const tolerations =
    (Array.isArray(runtimeConfig.tolerations) ? runtimeConfig.tolerations : null) ??
    parseEnvArray('JANGAR_AGENT_RUNNER_TOLERATIONS')
  const topologySpreadConstraints =
    (Array.isArray(runtimeConfig.topologySpreadConstraints) ? runtimeConfig.topologySpreadConstraints : null) ??
    parseEnvArray('JANGAR_AGENT_RUNNER_TOPOLOGY_SPREAD_CONSTRAINTS')
  const affinity = asRecord(runtimeConfig.affinity) ?? parseEnvRecord('JANGAR_AGENT_RUNNER_AFFINITY')
  const podSecurityContext =
    asRecord(runtimeConfig.podSecurityContext) ?? parseEnvRecord('JANGAR_AGENT_RUNNER_POD_SECURITY_CONTEXT')
  const priorityClassName =
    asString(runtimeConfig.priorityClassName) ?? asString(process.env.JANGAR_AGENT_RUNNER_PRIORITY_CLASS)
  const schedulerName =
    asString(runtimeConfig.schedulerName) ?? asString(process.env.JANGAR_AGENT_RUNNER_SCHEDULER_NAME)
  const imagePullSecrets = (() => {
    const candidates = Array.isArray(runtimeConfig.imagePullSecrets)
      ? runtimeConfig.imagePullSecrets
      : parseEnvArray('JANGAR_AGENT_RUNNER_IMAGE_PULL_SECRETS')
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

  if (authSecret) {
    const authHomeVolumeName = makeName(runName, options.nameSuffix ? `auth-home-${options.nameSuffix}` : 'auth-home')
    const authSecretVolumeName = makeName(
      runName,
      options.nameSuffix ? `auth-secret-${options.nameSuffix}` : 'auth-secret',
    )
    volumes.push({
      name: authHomeVolumeName,
      spec: { emptyDir: {} },
    })
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
      name: authHomeVolumeName,
      mountPath: authSecret.mountPath,
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

  const jobPodSpec: Record<string, unknown> = {
    serviceAccountName: serviceAccount ?? undefined,
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
          ...(authSecret
            ? [
                { name: 'CODEX_HOME', value: authSecret.mountPath },
                { name: 'CODEX_AUTH', value: buildAuthSecretPath(authSecret) },
              ]
            : []),
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
        resources: buildJobResources(workload),
        volumeMounts: [...volumeMounts, ...configVolumeMounts],
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

  const applied = await kube.apply(jobResource)
  return buildRuntimeRef(runtimeType, jobName, namespace, { uid: asString(readNested(applied, ['metadata', 'uid'])) })
}
