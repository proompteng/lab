import { Context, Effect, Layer } from 'effect'

import { errorResponse, okResponse, parseJsonBody, requireIdempotencyKey } from '../http'
import { asRecord, asString, normalizeNamespace } from '../primitives'
import type { OrchestrationRunRecord } from '../primitives-store'

import {
  describeOrchestrationSubmitError,
  OrchestrationSubmitKubeError,
  OrchestrationSubmitNotFoundError,
  OrchestrationSubmitPolicyDeniedError,
  OrchestrationSubmitStorageError,
  type OrchestrationRunSubmitStore,
  type SubmitOrchestrationRunDeps,
  submitOrchestrationRun,
} from './orchestration-submit'

export type OrchestrationRunsApiStore = OrchestrationRunSubmitStore & {
  getOrchestrationRunsByName: (orchestrationName: string) => Promise<OrchestrationRunRecord[]>
}

export type OrchestrationRunsApiDependencies = Omit<SubmitOrchestrationRunDeps, 'storeFactory'> & {
  storeFactory: () => OrchestrationRunsApiStore
  requireLeaderForMutation?: () => Response | null
}

type OrchestrationRunListStoreServiceDefinition = {
  readonly open: Effect.Effect<OrchestrationRunsApiStore, OrchestrationSubmitStorageError>
  readonly ready: (store: OrchestrationRunsApiStore) => Effect.Effect<void, OrchestrationSubmitStorageError>
  readonly listByName: (
    store: OrchestrationRunsApiStore,
    orchestrationName: string,
  ) => Effect.Effect<OrchestrationRunRecord[], OrchestrationSubmitStorageError>
  readonly close: (store: OrchestrationRunsApiStore) => Effect.Effect<void>
}

export class OrchestrationRunListStoreService extends Context.Tag('agents/OrchestrationRunListStoreService')<
  OrchestrationRunListStoreService,
  OrchestrationRunListStoreServiceDefinition
>() {}

type OrchestrationRunPayload = {
  orchestrationRef: { name: string }
  namespace: string
  parameters?: Record<string, string>
  policy?: Record<string, unknown>
}

const normalizeStringMap = (value: Record<string, unknown> | null): Record<string, string> | undefined => {
  if (!value) return undefined
  const entries = Object.entries(value)
  const output: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (raw == null) continue
    output[key] = typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
  return output
}

const parseOrchestrationRunPayload = (payload: Record<string, unknown>): OrchestrationRunPayload => {
  const orchestrationRef = asRecord(payload.orchestrationRef)
  const name = asString(orchestrationRef?.name)
  if (!name) throw new Error('orchestrationRef.name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const parameters = normalizeStringMap(asRecord(payload.parameters))
  const policy = asRecord(payload.policy) ?? undefined
  return { orchestrationRef: { name }, namespace, parameters, policy }
}

const listStoreEffect = <A>(
  operation: 'open-store' | 'store-ready' | 'list-runs',
  run: () => A | Promise<A>,
): Effect.Effect<A, OrchestrationSubmitStorageError> =>
  Effect.tryPromise({
    try: () => Promise.resolve(run()),
    catch: (cause) => new OrchestrationSubmitStorageError({ operation, cause }),
  })

const closeListStoreEffect = (store: OrchestrationRunsApiStore) =>
  Effect.tryPromise({
    try: () => store.close(),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.void))

export const makeOrchestrationRunListStoreLayer = (storeFactory: () => OrchestrationRunsApiStore) =>
  Layer.succeed(OrchestrationRunListStoreService, {
    open: listStoreEffect('open-store', storeFactory),
    ready: (store) => listStoreEffect('store-ready', () => Promise.resolve(store.ready).then(() => undefined)),
    listByName: (store, orchestrationName) =>
      listStoreEffect('list-runs', () => store.getOrchestrationRunsByName(orchestrationName)),
    close: closeListStoreEffect,
  })

export const listOrchestrationRunsWithServicesEffect = (
  orchestrationName: string,
): Effect.Effect<OrchestrationRunRecord[], OrchestrationSubmitStorageError, OrchestrationRunListStoreService> =>
  Effect.gen(function* () {
    const stores = yield* OrchestrationRunListStoreService
    return yield* Effect.acquireUseRelease(
      stores.open,
      (store) => stores.ready(store).pipe(Effect.zipRight(stores.listByName(store, orchestrationName))),
      stores.close,
    )
  })

const listOrchestrationRunsEffect = (
  deps: Pick<OrchestrationRunsApiDependencies, 'storeFactory'>,
  orchestrationName: string,
) =>
  listOrchestrationRunsWithServicesEffect(orchestrationName).pipe(
    Effect.provide(makeOrchestrationRunListStoreLayer(deps.storeFactory)),
  )

export const getOrchestrationRunsHandler = async (request: Request, deps: OrchestrationRunsApiDependencies) => {
  const url = new URL(request.url)
  const orchestrationName =
    asString(url.searchParams.get('orchestrationId')) ?? asString(url.searchParams.get('orchestrationName'))
  if (!orchestrationName) return errorResponse('orchestrationId is required', 400)

  const result = await Effect.runPromise(listOrchestrationRunsEffect(deps, orchestrationName).pipe(Effect.either))
  if (result._tag === 'Right') return okResponse({ ok: true, runs: result.right })
  return errorResponse(describeOrchestrationSubmitError(result.left), 503)
}

export const postOrchestrationRunsHandler = async (request: Request, deps: OrchestrationRunsApiDependencies) => {
  const leaderResponse = deps.requireLeaderForMutation?.()
  if (leaderResponse) return leaderResponse

  try {
    const deliveryId = requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseOrchestrationRunPayload(payload)

    const result = await submitOrchestrationRun(
      {
        deliveryId,
        orchestrationRef: parsed.orchestrationRef,
        namespace: parsed.namespace,
        parameters: parsed.parameters,
        policy: parsed.policy,
      },
      deps,
    )

    if (result.idempotent) {
      return okResponse({
        ok: true,
        orchestrationRun: result.orchestrationRun,
        resource: result.resource,
        idempotent: true,
      })
    }

    return okResponse({ ok: true, orchestrationRun: result.orchestrationRun, resource: result.resource }, 201)
  } catch (error) {
    const message = describeOrchestrationSubmitError(error)
    if (error instanceof OrchestrationSubmitNotFoundError) {
      return errorResponse(message, 404)
    }
    if (error instanceof OrchestrationSubmitStorageError) {
      return errorResponse(message, 503)
    }
    if (error instanceof OrchestrationSubmitPolicyDeniedError) {
      return errorResponse(message, 403)
    }
    if (error instanceof OrchestrationSubmitKubeError) return errorResponse(message, 502)
    return errorResponse(message, 400)
  }
}
