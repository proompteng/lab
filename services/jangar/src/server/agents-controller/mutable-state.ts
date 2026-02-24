import type { createTemporalClient } from '@proompteng/temporal-bun-sdk'

import type { createPrimitivesStore } from '~/server/primitives-store'
import { type AgentsControllerLifecycleActor, createAgentsControllerLifecycleActor } from './lifecycle-machine'

export type CrdCheckState = {
  ok: boolean
  missing: string[]
  checkedAt: string
}

export type RateBucket = { count: number; resetAt: number }

export type AgentsControllerMutableState<TControllerState> = {
  lifecycleActor: AgentsControllerLifecycleActor
  started: boolean
  starting: boolean
  lifecycleToken: number
  reconciling: boolean
  temporalClientPromise: ReturnType<typeof createTemporalClient> | null
  watchHandles: Array<{ stop: () => void }>
  controllerSnapshot: TControllerState | null
  namespaceQueues: Map<string, Promise<void>>
  githubAppTokenCache: Map<string, { token: string; expiresAt: number; refreshAfter: number }>
  primitivesStoreRef: ReturnType<typeof createPrimitivesStore> | null
  lastIdempotencyPruneAtMs: number
  crdCheckState: CrdCheckState | null
  controllerRateState: {
    cluster: RateBucket
    perNamespace: Map<string, RateBucket>
    perRepo: Map<string, RateBucket>
  }
}

export const createMutableState = <TControllerState>(input: {
  started: boolean
  crdCheckState: CrdCheckState | null
}): AgentsControllerMutableState<TControllerState> => ({
  lifecycleActor: createAgentsControllerLifecycleActor(),
  started: input.started,
  starting: false,
  lifecycleToken: 0,
  reconciling: false,
  temporalClientPromise: null,
  watchHandles: [],
  controllerSnapshot: null,
  namespaceQueues: new Map<string, Promise<void>>(),
  githubAppTokenCache: new Map<string, { token: string; expiresAt: number; refreshAfter: number }>(),
  primitivesStoreRef: null,
  lastIdempotencyPruneAtMs: 0,
  crdCheckState: input.crdCheckState,
  controllerRateState: {
    cluster: { count: 0, resetAt: 0 },
    perNamespace: new Map<string, RateBucket>(),
    perRepo: new Map<string, RateBucket>(),
  },
})
