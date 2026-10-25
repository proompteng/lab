import { Context, Effect, Layer } from 'effect'

import { AgentRunStorageError, type AgentRunStorageOperation } from './agent-run-errors'

export type AgentRunIdempotencyRecord = {
  namespace: string
  agentName: string
  idempotencyKey: string
  agentRunName: string | null
  agentRunUid: string | null
  createdAt: Date | string
}

export type AgentRunIdempotencyReservation = {
  record: AgentRunIdempotencyRecord
  created: boolean
}

export type AgentRunRecord = {
  id: string
  agentName: string
  deliveryId: string
  provider: string
  status: string
  externalRunId: string | null
  payload: Record<string, unknown>
  createdAt?: unknown
  updatedAt?: unknown
}

export type AgentRunListInput = {
  agentName?: string | null
  statuses?: string[] | null
  limit?: number | null
}

export type AgentRunsApiStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  listAgentRuns: (input?: AgentRunListInput) => Promise<unknown[]>
  getAgentRunByDeliveryId: (deliveryId: string) => Promise<AgentRunRecord | null>
  getAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
  }) => Promise<AgentRunIdempotencyRecord | null>
  reserveAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
  }) => Promise<AgentRunIdempotencyReservation>
  deleteAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
  }) => Promise<unknown>
  assignAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
    agentRunName: string
    agentRunUid: string | null
  }) => Promise<unknown>
  createAgentRun: (input: {
    agentName: string
    deliveryId: string
    provider: string
    status: string
    externalRunId: string | null
    payload: Record<string, unknown>
  }) => Promise<AgentRunRecord>
  createAuditEvent: (input: {
    entityType: string
    entityId: string
    eventType: string
    context?: Record<string, unknown>
    details?: Record<string, unknown>
  }) => Promise<unknown>
}

type AgentRunStoreServiceDefinition = {
  readonly open: Effect.Effect<AgentRunsApiStore, AgentRunStorageError>
  readonly ready: (store: AgentRunsApiStore) => Effect.Effect<void, AgentRunStorageError>
  readonly listRuns: (
    store: AgentRunsApiStore,
    input: AgentRunListInput,
  ) => Effect.Effect<unknown[], AgentRunStorageError>
  readonly getByDeliveryId: (
    store: AgentRunsApiStore,
    deliveryId: string,
  ) => Effect.Effect<AgentRunRecord | null, AgentRunStorageError>
  readonly getIdempotencyKey: (
    store: AgentRunsApiStore,
    input: { namespace: string; agentName: string; idempotencyKey: string },
  ) => Effect.Effect<AgentRunIdempotencyRecord | null, AgentRunStorageError>
  readonly reserveIdempotencyKey: (
    store: AgentRunsApiStore,
    input: { namespace: string; agentName: string; idempotencyKey: string },
  ) => Effect.Effect<AgentRunIdempotencyReservation, AgentRunStorageError>
  readonly deleteIdempotencyKey: (
    store: AgentRunsApiStore,
    input: { namespace: string; agentName: string; idempotencyKey: string },
  ) => Effect.Effect<unknown, AgentRunStorageError>
  readonly assignIdempotencyKey: (
    store: AgentRunsApiStore,
    input: {
      namespace: string
      agentName: string
      idempotencyKey: string
      agentRunName: string
      agentRunUid: string | null
    },
  ) => Effect.Effect<unknown, AgentRunStorageError>
  readonly createRun: (
    store: AgentRunsApiStore,
    input: Parameters<AgentRunsApiStore['createAgentRun']>[0],
  ) => Effect.Effect<AgentRunRecord, AgentRunStorageError>
  readonly createAuditEvent: (
    store: AgentRunsApiStore,
    input: Parameters<AgentRunsApiStore['createAuditEvent']>[0],
  ) => Effect.Effect<unknown, AgentRunStorageError>
  readonly close: (store: AgentRunsApiStore) => Effect.Effect<void>
}

export class AgentRunStoreService extends Context.Tag('agents/AgentRunStoreService')<
  AgentRunStoreService,
  AgentRunStoreServiceDefinition
>() {}

export const makeAgentRunStoreService = (storeFactory: () => AgentRunsApiStore): AgentRunStoreServiceDefinition => ({
  open: Effect.try({
    try: () => storeFactory(),
    catch: (cause) => new AgentRunStorageError({ operation: 'open-store', cause }),
  }),
  ready: (store) => waitForAgentRunsStoreReadyEffect(store),
  listRuns: (store, input) => storeEffect('list-runs', () => store.listAgentRuns(input)),
  getByDeliveryId: (store, deliveryId) =>
    storeEffect('read-delivery-id', () => store.getAgentRunByDeliveryId(deliveryId)),
  getIdempotencyKey: (store, input) =>
    storeEffect('read-idempotency-key', () => store.getAgentRunIdempotencyKey(input)),
  reserveIdempotencyKey: (store, input) =>
    storeEffect('reserve-idempotency-key', () => store.reserveAgentRunIdempotencyKey(input)),
  deleteIdempotencyKey: (store, input) =>
    storeEffect('delete-idempotency-key', () => store.deleteAgentRunIdempotencyKey(input)),
  assignIdempotencyKey: (store, input) =>
    storeEffect('assign-idempotency-key', () => store.assignAgentRunIdempotencyKey(input)),
  createRun: (store, input) => storeEffect('create-agent-run', () => store.createAgentRun(input)),
  createAuditEvent: (store, input) => storeEffect('create-audit-event', () => store.createAuditEvent(input)),
  close: closeAgentRunsStoreEffect,
})

export const makeAgentRunStoreLayer = (storeFactory: () => AgentRunsApiStore) =>
  Layer.succeed(AgentRunStoreService, makeAgentRunStoreService(storeFactory))

export const storeEffect = <A>(
  operation: AgentRunStorageOperation,
  run: () => Promise<A>,
): Effect.Effect<A, AgentRunStorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AgentRunStorageError({ operation, cause }),
  })

export const closeAgentRunsStoreEffect = (store: AgentRunsApiStore) =>
  Effect.tryPromise({
    try: () => store.close(),
    catch: (cause) => new AgentRunStorageError({ operation: 'close-store', cause }),
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.warn('[agents] failed to close AgentRun API store', error)
      }),
    ),
  )

export const waitForAgentRunsStoreReadyEffect = (store: AgentRunsApiStore) =>
  storeEffect('store-ready', () => Promise.resolve(store.ready).then(() => undefined))

export const listAgentRunsWithStoreEffect = (store: AgentRunsApiStore, input: AgentRunListInput) =>
  waitForAgentRunsStoreReadyEffect(store).pipe(
    Effect.zipRight(storeEffect('list-runs', () => store.listAgentRuns(input))),
  )

export const listAgentRunsWithServicesEffect = (
  input: AgentRunListInput,
): Effect.Effect<unknown[], AgentRunStorageError, AgentRunStoreService> =>
  Effect.gen(function* () {
    const stores = yield* AgentRunStoreService
    return yield* Effect.acquireUseRelease(
      stores.open,
      (store) => stores.ready(store).pipe(Effect.zipRight(stores.listRuns(store, input))),
      stores.close,
    )
  })
