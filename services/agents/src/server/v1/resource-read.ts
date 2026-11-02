import { Context, Data, Effect, Layer } from 'effect'

import { errorResponse, okResponse } from '../http'
import { createKubernetesClient, type KubernetesClient, RESOURCE_MAP } from '../kube-types'
import { asRecord, asString, normalizeNamespace, readNested } from '../primitives'
import { hydrateMemoryRecord } from '../primitives-memory'
import type { OrchestrationRunRecord } from '../primitives-store'

export type ResourceReadDependencies = {
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
}

export type OrchestrationRunReadStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  getOrchestrationRunById: (id: string) => Promise<OrchestrationRunRecord | null>
  updateOrchestrationRunDetails: (input: {
    id: string
    status: string
    externalRunId: string | null
    payload: Record<string, unknown>
  }) => Promise<OrchestrationRunRecord | null>
}

export type OrchestrationRunReadDependencies = ResourceReadDependencies & {
  storeFactory: () => OrchestrationRunReadStore
}

export type MemoryReadStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  upsertMemoryResource: (input: {
    memoryName: string
    provider: string
    status: string
    connectionSecret: Record<string, unknown> | null
  }) => Promise<unknown>
}

export type MemoryReadDependencies = ResourceReadDependencies & {
  storeFactory: () => MemoryReadStore
}

type ResourceReadKubeOperation = 'create-client' | 'get-resource'
type ResourceReadStorageOperation =
  | 'open-store'
  | 'store-ready'
  | 'get-orchestration-run'
  | 'update-orchestration-run'
  | 'hydrate-memory'

export class ResourceReadKubeError extends Data.TaggedError('ResourceReadKubeError')<{
  readonly operation: ResourceReadKubeOperation
  readonly resource: string
  readonly namespace: string
  readonly id: string
  readonly cause: unknown
}> {}

export class ResourceReadStorageError extends Data.TaggedError('ResourceReadStorageError')<{
  readonly operation: ResourceReadStorageOperation
  readonly cause: unknown
}> {}

export class ResourceReadNotFoundError extends Data.TaggedError('ResourceReadNotFoundError')<{
  readonly kind: 'Agent' | 'Orchestration' | 'OrchestrationRun' | 'Memory'
  readonly id: string
  readonly namespace: string
}> {}

type ResourceReadKubernetesServiceDefinition = {
  readonly client: (namespace: string) => Effect.Effect<KubernetesClient, ResourceReadKubeError>
  readonly get: (
    kube: KubernetesClient,
    resource: string,
    id: string,
    namespace: string,
  ) => Effect.Effect<Record<string, unknown> | null, ResourceReadKubeError>
}

type OrchestrationRunReadStoreServiceDefinition = {
  readonly open: Effect.Effect<OrchestrationRunReadStore, ResourceReadStorageError>
  readonly ready: (store: OrchestrationRunReadStore) => Effect.Effect<void, ResourceReadStorageError>
  readonly getById: (
    store: OrchestrationRunReadStore,
    id: string,
  ) => Effect.Effect<OrchestrationRunRecord | null, ResourceReadStorageError>
  readonly updateDetails: (
    store: OrchestrationRunReadStore,
    input: Parameters<OrchestrationRunReadStore['updateOrchestrationRunDetails']>[0],
  ) => Effect.Effect<OrchestrationRunRecord | null, ResourceReadStorageError>
  readonly close: (store: OrchestrationRunReadStore) => Effect.Effect<void>
}

type MemoryReadStoreServiceDefinition = {
  readonly open: Effect.Effect<MemoryReadStore, ResourceReadStorageError>
  readonly ready: (store: MemoryReadStore) => Effect.Effect<void, ResourceReadStorageError>
  readonly hydrate: (
    resource: Record<string, unknown>,
    namespace: string,
    kube: KubernetesClient,
    store: MemoryReadStore,
  ) => Effect.Effect<unknown, ResourceReadStorageError>
  readonly close: (store: MemoryReadStore) => Effect.Effect<void>
}

export class ResourceReadKubernetesService extends Context.Tag('agents/ResourceReadKubernetesService')<
  ResourceReadKubernetesService,
  ResourceReadKubernetesServiceDefinition
>() {}

export class OrchestrationRunReadStoreService extends Context.Tag('agents/OrchestrationRunReadStoreService')<
  OrchestrationRunReadStoreService,
  OrchestrationRunReadStoreServiceDefinition
>() {}

export class MemoryReadStoreService extends Context.Tag('agents/MemoryReadStoreService')<
  MemoryReadStoreService,
  MemoryReadStoreServiceDefinition
>() {}

export type ResourceReadError = ResourceReadKubeError | ResourceReadStorageError | ResourceReadNotFoundError

const getKubeClient = (deps: ResourceReadDependencies) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const describeResourceReadError = (error: unknown) => {
  if (error instanceof ResourceReadNotFoundError) return `${error.kind} not found`
  if (error instanceof ResourceReadStorageError) {
    return `resource read storage ${error.operation} failed: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof ResourceReadKubeError) {
    return `kubernetes ${error.operation} failed for ${error.resource}/${error.id} in namespace ${error.namespace}: ${toErrorMessage(
      error.cause,
    )}`
  }
  return toErrorMessage(error)
}

const resourceReadStatus = (error: ResourceReadError) => {
  if (error instanceof ResourceReadNotFoundError) return 404
  if (error instanceof ResourceReadStorageError) return 503
  if (error instanceof ResourceReadKubeError) return 502
  return 500
}

const storageEffect = <A>(
  operation: ResourceReadStorageOperation,
  run: () => Promise<A>,
): Effect.Effect<A, ResourceReadStorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ResourceReadStorageError({ operation, cause }),
  })

const kubeEffect = <A>(
  operation: ResourceReadKubeOperation,
  resource: string,
  id: string,
  namespace: string,
  run: () => Promise<A>,
): Effect.Effect<A, ResourceReadKubeError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new ResourceReadKubeError({ operation, resource, id, namespace, cause }),
  })

const closeOrchestrationStoreEffect = (store: OrchestrationRunReadStore) =>
  Effect.tryPromise({
    try: () => store.close(),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void))

const closeMemoryStoreEffect = (store: MemoryReadStore) =>
  Effect.tryPromise({
    try: () => store.close(),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void))

export const makeResourceReadKubernetesLayer = (deps: ResourceReadDependencies = {}) =>
  Layer.succeed(ResourceReadKubernetesService, {
    client: (namespace) =>
      Effect.try({
        try: () => getKubeClient(deps),
        catch: (cause) =>
          new ResourceReadKubeError({
            operation: 'create-client',
            resource: 'client',
            id: 'client',
            namespace,
            cause,
          }),
      }),
    get: (kube, resource, id, namespace) =>
      kubeEffect('get-resource', resource, id, namespace, () => kube.get(resource, id, namespace)),
  })

export const makeOrchestrationRunReadStoreLayer = (storeFactory: () => OrchestrationRunReadStore) =>
  Layer.succeed(OrchestrationRunReadStoreService, {
    open: Effect.try({
      try: () => storeFactory(),
      catch: (cause) => new ResourceReadStorageError({ operation: 'open-store', cause }),
    }),
    ready: (store) => storageEffect('store-ready', () => Promise.resolve(store.ready).then(() => undefined)),
    getById: (store, id) => storageEffect('get-orchestration-run', () => store.getOrchestrationRunById(id)),
    updateDetails: (store, input) =>
      storageEffect('update-orchestration-run', () => store.updateOrchestrationRunDetails(input)),
    close: closeOrchestrationStoreEffect,
  })

export const makeMemoryReadStoreLayer = (storeFactory: () => MemoryReadStore) =>
  Layer.succeed(MemoryReadStoreService, {
    open: Effect.try({
      try: () => storeFactory(),
      catch: (cause) => new ResourceReadStorageError({ operation: 'open-store', cause }),
    }),
    ready: (store) => storageEffect('store-ready', () => Promise.resolve(store.ready).then(() => undefined)),
    hydrate: (resource, namespace, kube, store) =>
      storageEffect('hydrate-memory', () => hydrateMemoryRecord(resource, namespace, kube, store)),
    close: closeMemoryStoreEffect,
  })

const readNamespace = (request: Request) => normalizeNamespace(new URL(request.url).searchParams.get('namespace'))

const extractStatusPhase = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status)
  return asString(status?.phase)
}

export const getAgentHandler = async (id: string, request: Request, deps: ResourceReadDependencies = {}) => {
  const namespace = readNamespace(request)
  const result = await Effect.runPromise(
    getResourceWithServicesEffect('Agent', RESOURCE_MAP.Agent, id, namespace).pipe(
      Effect.provide(makeResourceReadKubernetesLayer(deps)),
      Effect.either,
    ),
  )
  if (result._tag === 'Right') return okResponse({ ok: true, agent: result.right })
  return errorResponse(describeResourceReadError(result.left), resourceReadStatus(result.left), {
    namespace,
    id: asString(id),
  })
}

export const getOrchestrationHandler = async (id: string, request: Request, deps: ResourceReadDependencies = {}) => {
  const namespace = readNamespace(request)
  const result = await Effect.runPromise(
    getResourceWithServicesEffect('Orchestration', RESOURCE_MAP.Orchestration, id, namespace).pipe(
      Effect.provide(makeResourceReadKubernetesLayer(deps)),
      Effect.either,
    ),
  )
  if (result._tag === 'Right') return okResponse({ ok: true, orchestration: result.right })
  return errorResponse(describeResourceReadError(result.left), resourceReadStatus(result.left), {
    namespace,
    id: asString(id),
  })
}

export const getOrchestrationRunHandler = async (
  id: string,
  request: Request,
  deps: OrchestrationRunReadDependencies,
) => {
  const namespace = readNamespace(request)
  const result = await Effect.runPromise(
    getOrchestrationRunWithServicesEffect(id, namespace).pipe(
      Effect.provide(makeResourceReadKubernetesLayer(deps)),
      Effect.provide(makeOrchestrationRunReadStoreLayer(deps.storeFactory)),
      Effect.either,
    ),
  )
  if (result._tag === 'Right') {
    return okResponse({ ok: true, orchestrationRun: result.right.orchestrationRun, resource: result.right.resource })
  }
  return errorResponse(describeResourceReadError(result.left), resourceReadStatus(result.left))
}

export const getMemoryHandler = async (id: string, request: Request, deps: MemoryReadDependencies) => {
  const namespace = readNamespace(request)
  const result = await Effect.runPromise(
    getMemoryWithServicesEffect(id, namespace).pipe(
      Effect.provide(makeResourceReadKubernetesLayer(deps)),
      Effect.provide(makeMemoryReadStoreLayer(deps.storeFactory)),
      Effect.either,
    ),
  )
  if (result._tag === 'Right') return okResponse({ ok: true, memory: result.right.memory, record: result.right.record })
  return errorResponse(describeResourceReadError(result.left), resourceReadStatus(result.left))
}

export const getResourceWithServicesEffect = (
  kind: ResourceReadNotFoundError['kind'],
  resourceName: string,
  id: string,
  namespace: string,
): Effect.Effect<Record<string, unknown>, ResourceReadError, ResourceReadKubernetesService> =>
  Effect.gen(function* () {
    const kubeService = yield* ResourceReadKubernetesService
    const kube = yield* kubeService.client(namespace)
    const resource = yield* kubeService.get(kube, resourceName, id, namespace)
    if (!resource) {
      return yield* Effect.fail(new ResourceReadNotFoundError({ kind, id, namespace }))
    }
    return resource
  })

export const getOrchestrationRunWithServicesEffect = (
  id: string,
  namespace: string,
): Effect.Effect<
  { orchestrationRun: OrchestrationRunRecord; resource: Record<string, unknown> | null },
  ResourceReadError,
  OrchestrationRunReadStoreService | ResourceReadKubernetesService
> =>
  Effect.gen(function* () {
    const stores = yield* OrchestrationRunReadStoreService
    const kubeService = yield* ResourceReadKubernetesService

    return yield* Effect.acquireUseRelease(
      stores.open,
      (store) =>
        Effect.gen(function* () {
          yield* stores.ready(store)
          const record = yield* stores.getById(store, id)
          if (!record) {
            return yield* Effect.fail(new ResourceReadNotFoundError({ kind: 'OrchestrationRun', id, namespace }))
          }

          const resourceNamespace =
            asString(readNested(record.payload, ['resource', 'metadata', 'namespace'])) ??
            asString(readNested(record.payload, ['request', 'namespace'])) ??
            namespace
          const kube = yield* kubeService.client(resourceNamespace)
          const resource = record.externalRunId
            ? yield* kubeService.get(kube, RESOURCE_MAP.OrchestrationRun, record.externalRunId, resourceNamespace)
            : null
          if (!resource) return { orchestrationRun: record, resource }

          const phase = extractStatusPhase(resource)
          if (!phase || phase === record.status) return { orchestrationRun: record, resource }

          const updated = yield* stores.updateDetails(store, {
            id: record.id,
            status: phase,
            externalRunId: record.externalRunId,
            payload: { ...record.payload, resource },
          })

          return {
            orchestrationRun: updated ?? { ...record, status: phase, payload: { ...record.payload, resource } },
            resource,
          }
        }),
      stores.close,
    )
  })

export const getMemoryWithServicesEffect = (
  id: string,
  namespace: string,
): Effect.Effect<
  { memory: Record<string, unknown>; record: unknown },
  ResourceReadError,
  MemoryReadStoreService | ResourceReadKubernetesService
> =>
  Effect.gen(function* () {
    const stores = yield* MemoryReadStoreService
    const kubeService = yield* ResourceReadKubernetesService

    return yield* Effect.acquireUseRelease(
      stores.open,
      (store) =>
        Effect.gen(function* () {
          const kube = yield* kubeService.client(namespace)
          const resource = yield* kubeService.get(kube, RESOURCE_MAP.Memory, id, namespace)
          if (!resource) {
            return yield* Effect.fail(new ResourceReadNotFoundError({ kind: 'Memory', id, namespace }))
          }
          yield* stores.ready(store)
          const record = yield* stores.hydrate(resource, namespace, kube, store)
          return { memory: resource, record }
        }),
      stores.close,
    )
  })
