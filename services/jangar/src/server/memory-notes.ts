import { Context, Effect, Layer } from 'effect'

import {
  countMemoryNotesFromAgentsService,
  fetchMemoryNotesStatsFromAgentsService,
  persistMemoryNoteToAgentsService,
  retrieveMemoryNotesFromAgentsService,
  type AgentsMemoryNoteRecord,
  type AgentsMemoryNotesStats,
  type AgentsPersistMemoryNoteInput,
  type AgentsRetrieveMemoryNotesInput,
  type AgentsServiceJsonResult,
} from '@proompteng/agent-contracts/memory-client'

export type MemoryNotesService = {
  persist: (input: AgentsPersistMemoryNoteInput) => Effect.Effect<AgentsMemoryNoteRecord, Error>
  retrieve: (input: AgentsRetrieveMemoryNotesInput) => Effect.Effect<AgentsMemoryNoteRecord[], Error>
  count: (input?: { namespace?: string }) => Effect.Effect<number, Error>
  stats: (input?: {
    namespace?: string
    days?: number
    topNamespaces?: number
  }) => Effect.Effect<AgentsMemoryNotesStats, Error>
}

export class MemoryNotes extends Context.Tag('MemoryNotes')<MemoryNotes, MemoryNotesService>() {}

export class MemoryNotesServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'MemoryNotesServiceError'
  }
}

const normalizeError = (action: string, result: AgentsServiceJsonResult<unknown>) => {
  const message = result.ok ? `${action} failed` : (result.error ?? `Agents service returned HTTP ${result.status}`)
  return new MemoryNotesServiceError(message, result.ok ? 500 : result.status || 503)
}

const unwrapAgentsResult = <T>(action: string, result: AgentsServiceJsonResult<T>) => {
  if (!result.ok) throw normalizeError(action, result)
  return result.body
}

export const MemoryNotesLive = Layer.succeed(MemoryNotes, {
  persist: (input) =>
    Effect.tryPromise({
      try: async () => {
        const body = unwrapAgentsResult('persist memory note', await persistMemoryNoteToAgentsService(input))
        if (!body.memory) throw new Error('Agents memory note response missing memory')
        return body.memory
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }),
  retrieve: (input) =>
    Effect.tryPromise({
      try: async () => {
        const body = unwrapAgentsResult('retrieve memory notes', await retrieveMemoryNotesFromAgentsService(input))
        return body.memories ?? []
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }),
  count: (input = {}) =>
    Effect.tryPromise({
      try: async () => unwrapAgentsResult('count memory notes', await countMemoryNotesFromAgentsService(input)).count,
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }),
  stats: (input = {}) =>
    Effect.tryPromise({
      try: async () => {
        const { ok: _ok, ...stats } = unwrapAgentsResult(
          'fetch memory note stats',
          await fetchMemoryNotesStatsFromAgentsService(input),
        )
        return stats
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }),
})
