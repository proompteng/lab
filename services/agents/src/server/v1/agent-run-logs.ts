import { Context, Data, Effect, Layer } from 'effect'

import { errorResponse, okResponse } from '../http'
import { createKubernetesClient, type KubernetesClient } from '../kube-types'
import { asRecord, asString } from '../primitives'

export type PodContainer = {
  name: string
  type: 'main' | 'init'
}

export type AgentRunPod = {
  name: string
  phase: string | null
  containers: PodContainer[]
}

type AgentRunLogsRequest = {
  name: string
  namespace: string
  pod: string | null
  container: string | null
  tailLines: number | null
}

type AgentRunLogsSuccess = {
  ok: true
  name: string
  namespace: string
  pods: AgentRunPod[]
  logs: string
  pod: string | null
  container: string | null
  tailLines: number | null
}

export type AgentRunLogsDependencies = {
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
}

type AgentRunLogsKubeOperation = 'create-client' | 'list-pods' | 'read-pod-logs'

export class AgentRunLogsInvalidRequestError extends Data.TaggedError('AgentRunLogsInvalidRequestError')<{
  readonly message: string
}> {}

export class AgentRunLogsNotFoundError extends Data.TaggedError('AgentRunLogsNotFoundError')<{
  readonly message: string
  readonly details: Record<string, unknown>
}> {}

export class AgentRunLogsKubeError extends Data.TaggedError('AgentRunLogsKubeError')<{
  readonly operation: AgentRunLogsKubeOperation
  readonly namespace: string
  readonly name: string
  readonly cause: unknown
}> {}

type AgentRunLogsError = AgentRunLogsInvalidRequestError | AgentRunLogsNotFoundError | AgentRunLogsKubeError

type AgentRunLogsKubeServiceDefinition = {
  readonly listPods: (
    request: Pick<AgentRunLogsRequest, 'name' | 'namespace'>,
  ) => Effect.Effect<AgentRunPod[], AgentRunLogsKubeError>
  readonly readPodLogs: (
    request: Pick<AgentRunLogsRequest, 'name' | 'namespace' | 'tailLines'> & { pod: string; container: string },
  ) => Effect.Effect<string, AgentRunLogsKubeError>
}

export class AgentRunLogsKubeService extends Context.Tag('agents/AgentRunLogsKubeService')<
  AgentRunLogsKubeService,
  AgentRunLogsKubeServiceDefinition
>() {}

const parseTailLines = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(Math.floor(parsed), 5000)
}

const readContainerNames = (spec: Record<string, unknown>, key: 'containers' | 'initContainers') => {
  const entries = Array.isArray(spec[key]) ? spec[key] : []
  return entries.map((entry) => asString(asRecord(entry)?.name)).filter((name): name is string => Boolean(name))
}

export const readAgentRunPod = (item: Record<string, unknown>): AgentRunPod | null => {
  const metadata = asRecord(item.metadata) ?? {}
  const status = asRecord(item.status) ?? {}
  const spec = asRecord(item.spec) ?? {}
  const name = asString(metadata.name)
  if (!name) return null
  const containers = readContainerNames(spec, 'containers').map((entry) => ({ name: entry, type: 'main' as const }))
  const initContainers = readContainerNames(spec, 'initContainers').map((entry) => ({
    name: entry,
    type: 'init' as const,
  }))
  return {
    name,
    phase: asString(status.phase),
    containers: [...containers, ...initContainers],
  }
}

const pickDefaultPod = (pods: AgentRunPod[]) => pods.find((pod) => pod.phase === 'Running') ?? pods[0]

const getKubeClient = (deps: AgentRunLogsDependencies) =>
  Effect.try({
    try: () => deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient(),
    catch: (cause) =>
      new AgentRunLogsKubeError({
        operation: 'create-client',
        namespace: 'unknown',
        name: 'unknown',
        cause,
      }),
  })

const parseRequest = (request: Request): Effect.Effect<AgentRunLogsRequest, AgentRunLogsInvalidRequestError> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const name = asString(url.searchParams.get('name'))
    const namespace = asString(url.searchParams.get('namespace'))
    if (!name) {
      return yield* Effect.fail(new AgentRunLogsInvalidRequestError({ message: 'name is required' }))
    }
    if (!namespace) {
      return yield* Effect.fail(new AgentRunLogsInvalidRequestError({ message: 'namespace is required' }))
    }
    return {
      name,
      namespace,
      pod: asString(url.searchParams.get('pod')) ?? null,
      container: asString(url.searchParams.get('container')) ?? null,
      tailLines: parseTailLines(url.searchParams.get('tailLines') ?? url.searchParams.get('tail_lines')),
    }
  })

const kubeEffect = <A>(
  operation: AgentRunLogsKubeOperation,
  request: Pick<AgentRunLogsRequest, 'name' | 'namespace'>,
  run: () => Promise<A>,
): Effect.Effect<A, AgentRunLogsKubeError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AgentRunLogsKubeError({ operation, name: request.name, namespace: request.namespace, cause }),
  })

export const makeAgentRunLogsKubeLayer = (deps: AgentRunLogsDependencies = {}) =>
  Layer.effect(
    AgentRunLogsKubeService,
    getKubeClient(deps).pipe(
      Effect.map((kube) => ({
        listPods: (request) =>
          kubeEffect('list-pods', request, async () => {
            const list = await kube.list('pods', request.namespace, `agents.proompteng.ai/agent-run=${request.name}`)
            const items = Array.isArray(list.items) ? list.items : []
            return items
              .map((item) => readAgentRunPod(asRecord(item) ?? {}))
              .filter((pod): pod is AgentRunPod => Boolean(pod))
          }),
        readPodLogs: (request) =>
          kubeEffect('read-pod-logs', request, () =>
            kube.logs({
              pod: request.pod,
              namespace: request.namespace,
              container: request.container,
              tailLines: request.tailLines,
            }),
          ),
      })),
    ),
  )

export const getAgentRunLogsEffect = (
  request: Request,
): Effect.Effect<AgentRunLogsSuccess, AgentRunLogsError, AgentRunLogsKubeService> =>
  Effect.gen(function* () {
    const parsed = yield* parseRequest(request)
    const kube = yield* AgentRunLogsKubeService
    const pods = yield* kube.listPods(parsed)

    if (pods.length === 0) {
      return {
        ok: true,
        name: parsed.name,
        namespace: parsed.namespace,
        pods: [],
        logs: '',
        pod: null,
        container: null,
        tailLines: parsed.tailLines,
      }
    }

    const selectedPod = parsed.pod ? pods.find((pod) => pod.name === parsed.pod) : pickDefaultPod(pods)
    if (!selectedPod) {
      return yield* Effect.fail(
        new AgentRunLogsNotFoundError({
          message: 'pod not found',
          details: { name: parsed.name, namespace: parsed.namespace, pod: parsed.pod },
        }),
      )
    }

    const containers = selectedPod.containers
    if (containers.length === 0) {
      return yield* Effect.fail(
        new AgentRunLogsNotFoundError({
          message: 'pod has no containers',
          details: { name: parsed.name, namespace: parsed.namespace, pod: selectedPod.name },
        }),
      )
    }

    if (parsed.container && !containers.some((entry) => entry.name === parsed.container)) {
      return yield* Effect.fail(
        new AgentRunLogsNotFoundError({
          message: 'container not found',
          details: {
            name: parsed.name,
            namespace: parsed.namespace,
            pod: selectedPod.name,
            container: parsed.container,
          },
        }),
      )
    }

    const containerName =
      parsed.container ?? containers.find((entry) => entry.type === 'main')?.name ?? containers[0]?.name ?? null

    if (!containerName) {
      return yield* Effect.fail(
        new AgentRunLogsNotFoundError({
          message: 'container not found',
          details: { name: parsed.name, namespace: parsed.namespace, pod: selectedPod.name },
        }),
      )
    }

    const logs = yield* kube.readPodLogs({
      name: parsed.name,
      namespace: parsed.namespace,
      pod: selectedPod.name,
      container: containerName,
      tailLines: parsed.tailLines,
    })
    return {
      ok: true,
      name: parsed.name,
      namespace: parsed.namespace,
      pods,
      logs,
      pod: selectedPod.name,
      container: containerName,
      tailLines: parsed.tailLines,
    }
  })

const errorStatus = (error: AgentRunLogsError) => {
  if (error instanceof AgentRunLogsInvalidRequestError) return 400
  if (error instanceof AgentRunLogsNotFoundError) return 404
  return 502
}

const errorDetails = (error: AgentRunLogsError) => {
  if (error instanceof AgentRunLogsNotFoundError) return error.details
  if (error instanceof AgentRunLogsKubeError) {
    return { name: error.name, namespace: error.namespace, operation: error.operation }
  }
  return undefined
}

const errorMessage = (error: AgentRunLogsError) => {
  if (error instanceof AgentRunLogsInvalidRequestError || error instanceof AgentRunLogsNotFoundError) {
    return error.message
  }
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause)
  return `kubernetes ${error.operation} failed for AgentRun ${error.namespace}/${error.name}: ${cause}`
}

export const getAgentRunLogsHandler = async (request: Request, deps: AgentRunLogsDependencies = {}) => {
  const result = await Effect.runPromise(
    getAgentRunLogsEffect(request).pipe(Effect.provide(makeAgentRunLogsKubeLayer(deps)), Effect.either),
  )
  if (result._tag === 'Right') return okResponse(result.right)
  return errorResponse(errorMessage(result.left), errorStatus(result.left), errorDetails(result.left))
}
