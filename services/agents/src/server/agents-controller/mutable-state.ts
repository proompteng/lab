import type { createTemporalClient } from '@proompteng/temporal-bun-sdk'

import { type AgentsControllerLifecycleActor, createAgentsControllerLifecycleActor } from './lifecycle-machine'

export type CrdCheckState = {
  ok: boolean
  missing: string[]
  checkedAt: string
}

export type RateBucket = { count: number; resetAt: number }

export type AgentRunIngestionRuntimeState = {
  lastWatchEventAtMs: number | null
  lastResyncAtMs: number | null
  untouchedRunCount: number
  oldestUntouchedAgeSeconds: number | null
  degradedSinceMs: number | null
  healthyResyncStreak: number
  lastResyncSummarySignature: string | null
  lastStallSignature: string | null
}

export type AgentsPrimitivesStoreRef = {
  ready?: Promise<unknown>
  markAgentRunIdempotencyKeyTerminal: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
    terminalPhase: string
    terminalAt: string | null
  }) => Promise<unknown>
  reserveAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
  }) => Promise<{ record: { agentRunName: string | null } }>
  assignAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
    agentRunName: string
    agentRunUid?: string | null
  }) => Promise<{ agentRunName: string | null } | null>
  pruneAgentRunIdempotencyKeys: (retentionDays: number) => Promise<unknown>
}

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
  primitivesStoreRef: AgentsPrimitivesStoreRef | null
  lastIdempotencyPruneAtMs: number
  crdCheckState: CrdCheckState | null
  controllerRateState: {
    cluster: RateBucket
    perNamespace: Map<string, RateBucket>
    perRepo: Map<string, RateBucket>
  }
  agentRunIngestionState: Map<string, AgentRunIngestionRuntimeState>
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
  agentRunIngestionState: new Map<string, AgentRunIngestionRuntimeState>(),
})
