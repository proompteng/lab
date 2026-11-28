import * as grpc from '@grpc/grpc-js'
import * as Effect from 'effect/Effect'
import { posix } from 'node:path'

import { applyVcsMetadataToParameters } from '../../../src/server/agents-controller/run-utils'
import type { KubeBackend } from '../kube/backend'
import type { PodSpec } from '../kube/resources'
import {
  isTerminalPhase,
  jobTerminalPhase,
  observeRuns,
  readRun,
  readRunObservation,
  readRunWorkloads,
  type RunObservation,
  runtimeType,
  STEP_INDEX,
  timestamp,
} from '../kube/runs'
import { outputResource, parseJson, readNestedValue, RESOURCE_SPECS } from '../runtime'
import { asAgentctlError, validationError } from './errors'
import { buildEventContext } from './run-input'
import { renderRunRows } from './run-list'
import { redactRunText } from './run-redaction'

export const DEFAULT_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000
export const DEFAULT_RUN_INTERVAL_MS = 2000

const kubeError = (message: string) => ({ _tag: 'KubeError' as const, message })
const grpcError = (message: string) => ({ _tag: 'GrpcError' as const, message })
export const kubeCall = <T>(run: (signal: AbortSignal) => Promise<T>) =>
  Effect.tryPromise({ try: run, catch: (error) => asAgentctlError(error, 'KubeError') })

export const runnerContainer = (spec?: PodSpec) => spec?.containers?.find((c) => c.name === 'agent-runner')

export const projectedMcpToken = (spec?: PodSpec) => {
  const container = runnerContainer(spec)
  const path = container?.env?.find((env) => env.name === 'AGENTS_MCP_IDENTITY_TOKEN_PATH')?.value
  if (!path) return undefined
  for (const mount of container?.volumeMounts ?? []) {
    if (!mount.readOnly || mount.subPath || mount.subPathExpr) continue
    const volume = spec?.volumes?.find((volume) => volume.name === mount.name)
    for (const source of volume?.projected?.sources ?? []) {
      const token = source.serviceAccountToken
      if (token?.audience && token.path && posix.join(mount.mountPath, token.path) === path) {
        return { audience: token.audience, mountPath: mount.mountPath }
      }
    }
  }
  return undefined
}

const mountedRunSpec = (spec?: PodSpec) => {
  const mount = runnerContainer(spec)?.volumeMounts?.find(
    (mount) => mount.mountPath === '/workspace/run.json' && mount.subPath === 'run.json',
  )
  return mount ? spec?.volumes?.find((volume) => volume.name === mount.name)?.configMap?.name : undefined
}

const readPrompt = async (
  backend: KubeBackend,
  namespace: string,
  observation: RunObservation,
  signal?: AbortSignal,
  mountedOnly = false,
) => {
  const name =
    mountedRunSpec(observation.pod?.spec) ??
    (!mountedOnly ? (mountedRunSpec(observation.job?.spec?.template?.spec) ?? `${observation.name}-spec`) : undefined)
  if (!name) return undefined
  const map = await backend.getConfigMap(namespace, name, signal)
  if (!map) return undefined
  const owner = map.metadata.ownerReferences?.find((ref) => ref.kind === 'AgentRun')
  if (owner && (owner.name !== observation.name || (owner.uid && owner.uid !== observation.run.metadata.uid))) {
    throw kubeError(`ConfigMap ${name} belongs to another AgentRun.`)
  }
  const raw = map.data?.['run.json']
  if (!raw) throw kubeError(`ConfigMap ${name} has no run.json.`)
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw kubeError(`ConfigMap ${name} has invalid run.json.`)
  }
  const prompt = readNestedValue(payload, ['prompt'])
  if (typeof prompt !== 'string' || !prompt.trim()) throw kubeError(`ConfigMap ${name} has no valid run.json.prompt.`)
  return { name, prompt }
}

// Only render the bounded preview, never the run payload, environment, or projected credential.
const preview = (value: string, max = 240) => {
  const text = redactRunText(value).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export const describeRun = async (backend: KubeBackend, namespace: string, observation: RunObservation) => {
  const { run, name, phase, observedPhase, job, jobPhase, pod, podPhase, node, serviceAccount } = observation
  const ref = run.status?.runtimeRef
  const projected = projectedMcpToken(pod?.spec ?? job?.spec?.template?.spec)
  const targets = [
    { kind: 'AgentRun', metadata: run.metadata },
    ...(job ? [{ kind: 'Job', metadata: job.metadata }] : []),
    ...(pod ? [{ kind: 'Pod', metadata: pod.metadata }] : []),
  ]
  const [prompt, eventReads] = await Promise.all([
    readPrompt(backend, namespace, observation).then(
      (payload) => (payload ? `  ${payload.name}: ${preview(payload.prompt)}` : '  Not yet available.'),
      () => '  Unavailable: check ConfigMap access and run.json.',
    ),
    Promise.all(
      targets.map(({ kind, metadata }) =>
        backend
          .listEvents(
            namespace,
            metadata.uid
              ? `involvedObject.uid=${metadata.uid}`
              : `involvedObject.kind=${kind},involvedObject.name=${metadata.name}`,
          )
          .catch(() => undefined),
      ),
    ),
  ])
  console.log(
    [
      `Name:      ${name}`,
      `Namespace: ${namespace}`,
      `Agent:     ${observation.agent ?? '-'}`,
      `Phase:     ${phase}${observation.stale ? ` (workload: ${observedPhase}; CR and workload disagree)` : ''}`,
      `Runtime:   ${runtimeType(run) ?? '-'}${ref?.name ? `/${ref.name} (namespace ${ref.namespace ?? namespace}${ref.uid ? `, UID ${ref.uid}` : ''})` : ' (no runtimeRef)'}`,
      `Job:       ${job ? `${job.metadata.name} (${jobPhase})` : '-'}`,
      `Pod:       ${pod ? `${pod.metadata.name} (${podPhase ?? 'unknown'})` : '-'}`,
      `Node:      ${node ?? '-'}`,
      `SA:        ${serviceAccount ?? '-'}`,
      `Head:      ${observation.head ?? '-'}`,
      `MCP token: ${projected ? `projected into agent-runner at ${projected.mountPath} (audience: ${projected.audience})` : pod || job ? 'projection/mount not found' : 'no Job or Pod to check'}`,
      'Conditions:',
      ...(run.status?.conditions?.map(
        ({ type, status, reason, message }) =>
          `  ${type}=${status}${reason ? ` (${reason})` : ''}${message ? `: ${preview(message)}` : ''}`,
      ) ?? []),
      ...(run.status?.conditions?.length ? [] : ['  None.']),
      'run.json.prompt:',
      prompt,
      'Recent Events:',
    ].join('\n'),
  )
  const events = eventReads
    .flatMap((items) => items ?? [])
    .map((event) => ({
      event,
      time:
        event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp,
    }))
    .sort((a, b) => timestamp(b.time) - timestamp(a.time))
    .slice(0, 10)
  if (eventReads.some((items) => items === undefined))
    console.log('  Some Events could not be read; check Events list access.')
  else if (events.length === 0) console.log('  None.')
  for (const { event, time } of events) {
    const count = event.series?.count ?? event.count ?? 1
    console.log(
      `  ${time ?? '-'} ${event.type ?? ''} ${event.involvedObject.kind}/${event.involvedObject.name} ${event.reason ?? ''}${count > 1 ? ` (x${count})` : ''}: ${preview(event.message ?? '')}`,
    )
  }
}

export const waitForRunCompletionKube = (
  backend: KubeBackend,
  name: string,
  namespace: string,
  output: string,
  timeout = DEFAULT_RUN_TIMEOUT_MS,
  interval = DEFAULT_RUN_INTERVAL_MS,
) =>
  Effect.gen(function* () {
    while (true) {
      const resource = yield* kubeCall((signal) => readRun(backend, namespace, name, signal))
      const phase = readNestedValue(resource, ['status', 'phase'])
      if (typeof phase === 'string' && isTerminalPhase(phase)) {
        outputResource(resource, output)
        if (phase.toLowerCase() !== 'succeeded') return yield* Effect.fail(kubeError(`AgentRun ${name}: ${phase}`))
        return
      }
      const { jobs, pods } = yield* kubeCall((signal) => readRunWorkloads(backend, namespace, name, signal))
      const observation = yield* Effect.try({
        try: () => observeRuns([resource], jobs, pods, namespace)[0],
        catch: (error) => asAgentctlError(error, 'KubeError'),
      })
      if (isTerminalPhase(observation.observedPhase)) {
        const source =
          observation.job && jobTerminalPhase(observation.job)
            ? `Job ${observation.job.metadata.name}`
            : `Pod ${observation.pod?.metadata.name}`
        const message = `AgentRun ${name}: ${source} indicates ${observation.observedPhase}; CR phase is still ${observation.phase}.`
        if (output === 'table' || output === 'wide') renderRunRows([observation], output)
        else outputResource(resource, output)
        if (observation.observedPhase !== 'Succeeded') return yield* Effect.fail(kubeError(message))
        console.warn(message)
        return
      }
      yield* Effect.sleep(interval)
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(kubeError(`Timed out waiting for AgentRun ${name}.`)),
    }),
  )

export const waitForRunCompletion = (
  client: grpc.Client,
  metadata: grpc.Metadata,
  name: string,
  namespace: string,
  output: string,
  timeout = DEFAULT_RUN_TIMEOUT_MS,
) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        const stream = (
          client as unknown as Record<string, (...args: unknown[]) => grpc.ClientReadableStream<{ json?: string }>>
        ).StreamAgentRunStatus
        if (!stream) return reject(grpcError('StreamAgentRunStatus not available'))
        const call = stream.call(client, { name, namespace }, metadata, { deadline: Date.now() + timeout })
        const onAbort = () => call.cancel()
        signal.addEventListener('abort', onAbort, { once: true })
        call.once('status', () => signal.removeEventListener('abort', onAbort))
        let latest: Record<string, unknown> | null = null
        call.on('data', ({ json }) => {
          if (!json) return
          try {
            latest = parseJson(json)
          } catch {
            reject(grpcError('Status stream returned invalid AgentRun JSON.'))
            call.cancel()
          }
        })
        call.on('error', (error: grpc.ServiceError) =>
          reject(
            error.code === grpc.status.DEADLINE_EXCEEDED ? grpcError(`Timed out waiting for AgentRun ${name}.`) : error,
          ),
        )
        call.on('end', () => {
          if (latest) outputResource(latest, output)
          const phase = readNestedValue(latest, ['status', 'phase'])
          if (typeof phase !== 'string' || !isTerminalPhase(phase)) {
            return reject(grpcError(`AgentRun ${name}: status stream closed before a terminal phase.`))
          }
          if (phase.toLowerCase() !== 'succeeded') return reject(grpcError(`AgentRun ${name}: ${phase}`))
          resolve()
        })
      }),
    catch: (error) => asAgentctlError(error, 'GrpcError'),
  })

export const readVerificationIdentity = (backend: KubeBackend, namespace: string, agentName: string) =>
  Effect.gen(function* () {
    const agent = yield* kubeCall((signal) =>
      backend.getCustomObject(RESOURCE_SPECS.agent, namespace, agentName, signal),
    )
    const providerName = readNestedValue(agent, ['spec', 'providerRef', 'name'])
    if (typeof providerName !== 'string' || !providerName) {
      return yield* Effect.fail(validationError('--verify requires an Agent with an AgentProvider reference.'))
    }
    const provider = yield* kubeCall((signal) =>
      backend.getCustomObject(RESOURCE_SPECS.provider, namespace, providerName, signal),
    )
    const serviceAccountName = readNestedValue(provider, ['spec', 'workload', 'serviceAccountName'])
    const audience = readNestedValue(provider, ['spec', 'workload', 'serviceAccountToken', 'audience'])
    const mountPath = readNestedValue(provider, ['spec', 'workload', 'serviceAccountToken', 'mountPath'])
    if (
      typeof serviceAccountName !== 'string' ||
      !serviceAccountName ||
      typeof audience !== 'string' ||
      !audience ||
      typeof mountPath !== 'string' ||
      !mountPath
    ) {
      return yield* Effect.fail(
        validationError('--verify requires an AgentProvider with a service account and MCP token projection.'),
      )
    }
    return { serviceAccountName, audience, mountPath }
  })

export type Verification = { serviceAccountName: string; audience: string; mountPath: string } & (
  | { prompt: string }
  | { stepPrompts: readonly string[] }
  | { jobTask: { implementation: Record<string, unknown>; parameters: Record<string, string> } }
)

const expectedPrompt = (expected: Verification, observation: RunObservation) => {
  if ('prompt' in expected) return expected.prompt
  if ('jobTask' in expected) {
    const { implementation, parameters } = expected.jobTask
    const status = observation.run.status
    // A skipped VCS resolution may report branches without applying them to the prompt.
    const vcsSkipped = status?.conditions?.some(({ type, status }) => type === 'VcsSkipped' && status === 'True')
    const resolved = applyVcsMetadataToParameters(parameters, vcsSkipped ? null : (status?.vcs ?? null))
    return buildEventContext(implementation, resolved).payload.prompt
  }
  const index = Number(observation.pod?.metadata.labels?.[STEP_INDEX] ?? observation.job?.metadata.labels?.[STEP_INDEX])
  return expected.stepPrompts.length === 1 ? expected.stepPrompts[0] : expected.stepPrompts[index - 1]
}

export const verifyRun = (
  backend: KubeBackend,
  namespace: string,
  name: string,
  expected: Verification,
  timeout = 60_000,
  interval = DEFAULT_RUN_INTERVAL_MS,
) =>
  Effect.gen(function* () {
    while (true) {
      const observation = yield* kubeCall((signal) => readRunObservation(backend, namespace, name, signal))
      const spec = observation.pod?.spec
      // The Job and Pod can appear before the controller publishes the resolved VCS status.
      if (spec && (!('jobTask' in expected) || observation.phase !== 'Pending')) {
        const account = spec.serviceAccountName
        if (account !== expected.serviceAccountName) {
          return yield* Effect.fail(
            kubeError(`AgentRun ${name}: Pod did not inherit service account ${expected.serviceAccountName}.`),
          )
        }
        const projection = projectedMcpToken(spec)
        if (projection?.audience !== expected.audience || projection.mountPath !== expected.mountPath) {
          return yield* Effect.fail(
            kubeError(`AgentRun ${name}: projected MCP token is not correctly mounted in agent-runner.`),
          )
        }
        const payload = yield* kubeCall((signal) => readPrompt(backend, namespace, observation, signal, true))
        if (payload) {
          const prompt = expectedPrompt(expected, observation)
          if (typeof prompt !== 'string' || payload.prompt.trim() !== prompt.trim()) {
            return yield* Effect.fail(
              kubeError(`AgentRun ${name}: ${payload.name} run.json.prompt does not match the task text.`),
            )
          }
          return { configMap: payload.name, account, node: observation.node }
        }
      }
      if (isTerminalPhase(observation.phase)) {
        return yield* Effect.fail(
          kubeError(`AgentRun ${name} reached ${observation.phase} without a verifiable Pod and run-spec ConfigMap.`),
        )
      }
      yield* Effect.sleep(interval)
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          kubeError(
            `Timed out verifying AgentRun ${name}: inspect its Pod and run-spec ConfigMap with agentctl describe run ${name}.`,
          ),
        ),
    }),
  )
