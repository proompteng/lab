import { Context, Data, Effect, Layer } from 'effect'

import { errorResponse, okResponse } from '../http'
import { createKubernetesClient, type KubernetesClient, RESOURCE_MAP } from '../kube-types'
import { asRecord, asString, normalizeNamespace, readNested } from '../primitives'

import { type AgentRunRecord } from './agent-runs'

type Timestamp = string | Date

export type OrchestrationRunRecord = {
  id: string
  orchestrationName: string
  deliveryId: string
  provider: string
  status: string
  externalRunId: string | null
  payload: Record<string, unknown>
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

export type AgentRunDetailsUpdate = {
  id: string
  status: string
  externalRunId?: string | null
  payload?: Record<string, unknown>
}

export type RunLookupRecord = {
  kind: 'agent' | 'orchestration'
  record: AgentRunRecord | OrchestrationRunRecord
}

export type RunReadApiStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  getAgentRunById: (id: string) => Promise<AgentRunRecord | null>
  updateAgentRunDetails: (input: AgentRunDetailsUpdate) => Promise<AgentRunRecord | null>
  getRunById: (id: string) => Promise<RunLookupRecord | null>
  updateOrchestrationRunDetails: (input: AgentRunDetailsUpdate) => Promise<OrchestrationRunRecord | null>
}

export type RunReadApiDependencies = {
  storeFactory: () => RunReadApiStore
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
  defaultNamespace?: string
}

type RunReadStorageOperation =
  | 'open-store'
  | 'store-ready'
  | 'read-agent-run'
  | 'read-run'
  | 'update-agent-run'
  | 'update-orchestration-run'

type RunReadKubeOperation = 'create-client' | 'get-resource'

type RunReadResourceKind = 'AgentRun' | 'OrchestrationRun'

export class RunReadStorageError extends Data.TaggedError('RunReadStorageError')<{
  readonly operation: RunReadStorageOperation
  readonly cause: unknown
}> {}

export class RunReadKubeError extends Data.TaggedError('RunReadKubeError')<{
  readonly operation: RunReadKubeOperation
  readonly resource: string
  readonly name?: string
  readonly namespace: string
  readonly cause: unknown
}> {}

export class RunReadNotFoundError extends Data.TaggedError('RunReadNotFoundError')<{
  readonly kind: 'AgentRun' | 'Run'
  readonly id: string
}> {}

export type RunReadError = RunReadStorageError | RunReadKubeError | RunReadNotFoundError

type RunReadStoreServiceDefinition = {
  readonly open: Effect.Effect<RunReadApiStore, RunReadStorageError>
  readonly ready: (store: RunReadApiStore) => Effect.Effect<void, RunReadStorageError>
  readonly getAgentRunById: (
    store: RunReadApiStore,
    id: string,
  ) => Effect.Effect<AgentRunRecord | null, RunReadStorageError>
  readonly getRunById: (
    store: RunReadApiStore,
    id: string,
  ) => Effect.Effect<RunLookupRecord | null, RunReadStorageError>
  readonly updateAgentRunDetails: (
    store: RunReadApiStore,
    input: AgentRunDetailsUpdate,
  ) => Effect.Effect<AgentRunRecord | null, RunReadStorageError>
  readonly updateOrchestrationRunDetails: (
    store: RunReadApiStore,
    input: AgentRunDetailsUpdate,
  ) => Effect.Effect<OrchestrationRunRecord | null, RunReadStorageError>
  readonly close: (store: RunReadApiStore) => Effect.Effect<void>
}

type RunReadKubernetesServiceDefinition = {
  readonly client: (namespace: string) => Effect.Effect<KubernetesClient, RunReadKubeError>
  readonly getResource: (
    kube: KubernetesClient,
    kind: RunReadResourceKind,
    name: string,
    namespace: string,
  ) => Effect.Effect<Record<string, unknown> | null, RunReadKubeError>
}

export class RunReadStoreService extends Context.Tag('agents/RunReadStoreService')<
  RunReadStoreService,
  RunReadStoreServiceDefinition
>() {}

export class RunReadKubernetesService extends Context.Tag('agents/RunReadKubernetesService')<
  RunReadKubernetesService,
  RunReadKubernetesServiceDefinition
>() {}

export type RunReadServices = RunReadStoreService | RunReadKubernetesService

const extractStatusPhase = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status)
  return asString(status?.phase)
}

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const describeRunReadError = (error: RunReadError) => {
  if (error instanceof RunReadNotFoundError) return `${error.kind} not found`
  if (error instanceof RunReadStorageError)
    return `run read storage ${error.operation} failed: ${toErrorMessage(error.cause)}`
  if (error instanceof RunReadKubeError) {
    return `kubernetes ${error.operation} failed for ${error.resource}${
      error.name ? `/${error.name}` : ''
    } in namespace ${error.namespace}: ${toErrorMessage(error.cause)}`
  }
  return toErrorMessage(error)
}

export const runReadStatus = (error: RunReadError) => {
  if (error instanceof RunReadNotFoundError) return 404
  if (error instanceof RunReadStorageError && toErrorMessage(error.cause).includes('DATABASE_URL')) return 503
  return 500
}

const resolveResourceNamespace = (payload: Record<string, unknown>, fallbackNamespace: string) =>
  asString(readNested(payload, ['resource', 'metadata', 'namespace'])) ??
  asString(readNested(payload, ['request', 'namespace'])) ??
  fallbackNamespace

const getKubeClient = (deps: Pick<RunReadApiDependencies, 'kubeClient' | 'kubeClientFactory'>) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const storeEffect = <A>(
  operation: RunReadStorageOperation,
  run: () => Promise<A>,
): Effect.Effect<A, RunReadStorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RunReadStorageError({ operation, cause }),
  })

const kubeEffect = <A>(
  operation: RunReadKubeOperation,
  resource: string,
  namespace: string,
  run: () => Promise<A>,
  name?: string,
): Effect.Effect<A, RunReadKubeError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RunReadKubeError({ operation, resource, name, namespace, cause }),
  })

const closeStoreEffect = (store: RunReadApiStore) =>
  Effect.tryPromise({
    try: () => store.close(),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void))

export const makeRunReadStoreService = (
  storeFactory: RunReadApiDependencies['storeFactory'],
): RunReadStoreServiceDefinition => ({
  open: Effect.try({
    try: () => storeFactory(),
    catch: (cause) => new RunReadStorageError({ operation: 'open-store', cause }),
  }),
  ready: (store) => storeEffect('store-ready', () => Promise.resolve(store.ready).then(() => undefined)),
  getAgentRunById: (store, id) => storeEffect('read-agent-run', () => store.getAgentRunById(id)),
  getRunById: (store, id) => storeEffect('read-run', () => store.getRunById(id)),
  updateAgentRunDetails: (store, input) => storeEffect('update-agent-run', () => store.updateAgentRunDetails(input)),
  updateOrchestrationRunDetails: (store, input) =>
    storeEffect('update-orchestration-run', () => store.updateOrchestrationRunDetails(input)),
  close: closeStoreEffect,
})

export const makeRunReadLayer = (deps: RunReadApiDependencies) =>
  Layer.mergeAll(
    Layer.succeed(RunReadStoreService, makeRunReadStoreService(deps.storeFactory)),
    Layer.succeed(RunReadKubernetesService, {
      client: (namespace) =>
        Effect.try({
          try: () => getKubeClient(deps),
          catch: (cause) =>
            new RunReadKubeError({
              operation: 'create-client',
              resource: 'kubernetes-client',
              namespace,
              cause,
            }),
        }),
      getResource: (kube, kind, name, namespace) =>
        kubeEffect(
          'get-resource',
          RESOURCE_MAP[kind],
          namespace,
          () => kube.get(RESOURCE_MAP[kind], name, namespace),
          name,
        ),
    }),
  )

const refreshAgentRecordFromResourceEffect = (
  stores: RunReadStoreServiceDefinition,
  store: RunReadApiStore,
  record: AgentRunRecord,
  resource: Record<string, unknown> | null,
): Effect.Effect<AgentRunRecord, RunReadStorageError> =>
  Effect.gen(function* () {
    if (!resource) return record
    const phase = extractStatusPhase(resource)
    if (!phase || phase === record.status) return record

    yield* stores.updateAgentRunDetails(store, {
      id: record.id,
      status: phase,
      externalRunId: record.externalRunId,
      payload: { ...record.payload, resource },
    })
    return { ...record, status: phase }
  })

const refreshRunRecordFromResourceEffect = (
  stores: RunReadStoreServiceDefinition,
  store: RunReadApiStore,
  run: RunLookupRecord,
  resource: Record<string, unknown> | null,
): Effect.Effect<RunLookupRecord, RunReadStorageError> =>
  Effect.gen(function* () {
    if (!resource) return run
    const phase = extractStatusPhase(resource)
    if (!phase || phase === run.record.status) return run

    if (run.kind === 'agent') {
      yield* stores.updateAgentRunDetails(store, {
        id: run.record.id,
        status: phase,
        externalRunId: run.record.externalRunId,
        payload: { ...run.record.payload, resource },
      })
    } else {
      yield* stores.updateOrchestrationRunDetails(store, {
        id: run.record.id,
        status: phase,
        externalRunId: run.record.externalRunId,
        payload: { ...run.record.payload, resource },
      })
    }

    return { ...run, record: { ...run.record, status: phase } }
  })

export const getAgentRunWithServicesEffect = (
  id: string,
  namespace: string,
): Effect.Effect<
  { agentRun: AgentRunRecord; resource: Record<string, unknown> | null },
  RunReadError,
  RunReadServices
> =>
  Effect.gen(function* () {
    const stores = yield* RunReadStoreService
    const kubernetes = yield* RunReadKubernetesService

    return yield* Effect.acquireUseRelease(
      stores.open,
      (activeStore) =>
        Effect.gen(function* () {
          yield* stores.ready(activeStore)
          const record = yield* stores.getAgentRunById(activeStore, id)
          if (!record) return yield* Effect.fail(new RunReadNotFoundError({ kind: 'AgentRun', id }))

          const resourceNamespace = resolveResourceNamespace(record.payload, namespace)
          const kube = yield* kubernetes.client(resourceNamespace)
          const resource = record.externalRunId
            ? yield* kubernetes.getResource(kube, 'AgentRun', record.externalRunId, resourceNamespace)
            : null
          const agentRun = yield* refreshAgentRecordFromResourceEffect(stores, activeStore, record, resource)
          return { agentRun, resource }
        }),
      stores.close,
    )
  })

export const getRunWithServicesEffect = (
  id: string,
  namespace: string,
): Effect.Effect<
  {
    kind: RunLookupRecord['kind']
    run: AgentRunRecord | OrchestrationRunRecord
    resource: Record<string, unknown> | null
  },
  RunReadError,
  RunReadServices
> =>
  Effect.gen(function* () {
    const stores = yield* RunReadStoreService
    const kubernetes = yield* RunReadKubernetesService

    return yield* Effect.acquireUseRelease(
      stores.open,
      (activeStore) =>
        Effect.gen(function* () {
          yield* stores.ready(activeStore)
          const run = yield* stores.getRunById(activeStore, id)
          if (!run) return yield* Effect.fail(new RunReadNotFoundError({ kind: 'Run', id }))

          let resource: Record<string, unknown> | null = null
          if (run.record.externalRunId) {
            const resourceNamespace = resolveResourceNamespace(run.record.payload, namespace)
            const kube = yield* kubernetes.client(resourceNamespace)
            const resourceKind = run.kind === 'agent' ? 'AgentRun' : 'OrchestrationRun'
            resource = yield* kubernetes.getResource(kube, resourceKind, run.record.externalRunId, resourceNamespace)
          }
          const refreshedRun = yield* refreshRunRecordFromResourceEffect(stores, activeStore, run, resource)
          return { kind: refreshedRun.kind, run: refreshedRun.record, resource }
        }),
      stores.close,
    )
  })

export const getAgentRunEffect = (
  id: string,
  namespace: string,
  deps: RunReadApiDependencies,
): Effect.Effect<{ agentRun: AgentRunRecord; resource: Record<string, unknown> | null }, RunReadError> =>
  getAgentRunWithServicesEffect(id, namespace).pipe(Effect.provide(makeRunReadLayer(deps)))

export const getRunEffect = (
  id: string,
  namespace: string,
  deps: RunReadApiDependencies,
): Effect.Effect<
  {
    kind: RunLookupRecord['kind']
    run: AgentRunRecord | OrchestrationRunRecord
    resource: Record<string, unknown> | null
  },
  RunReadError
> => getRunWithServicesEffect(id, namespace).pipe(Effect.provide(makeRunReadLayer(deps)))

export const getAgentRunHandler = async (id: string, request: Request, deps: RunReadApiDependencies) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), deps.defaultNamespace)
  const result = await Effect.runPromise(getAgentRunEffect(id, namespace, deps).pipe(Effect.either))
  if (result._tag === 'Right')
    return okResponse({ ok: true, agentRun: result.right.agentRun, resource: result.right.resource })
  return errorResponse(describeRunReadError(result.left), runReadStatus(result.left))
}

export const getRunHandler = async (id: string, request: Request, deps: RunReadApiDependencies) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), deps.defaultNamespace)
  const result = await Effect.runPromise(getRunEffect(id, namespace, deps).pipe(Effect.either))
  if (result._tag === 'Right') {
    return okResponse({ ok: true, kind: result.right.kind, run: result.right.run, resource: result.right.resource })
  }
  return errorResponse(describeRunReadError(result.left), runReadStatus(result.left))
}
