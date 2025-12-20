import { Context, Effect, Layer, pipe } from 'effect'

import { createRedisWorktreeStore, type WorktreeStore } from './worktree-store'

export class WorktreeStateUnavailableError extends Error {
  readonly _tag = 'WorktreeStateUnavailableError'
}

export type WorktreeStateService = {
  getWorktreeName: (chatId: string) => Effect.Effect<string | null, Error>
  setWorktreeName: (chatId: string, worktreeName: string) => Effect.Effect<void, Error>
  clearWorktree: (chatId: string) => Effect.Effect<void, Error>
}

export class WorktreeState extends Context.Tag('WorktreeState')<WorktreeState, WorktreeStateService>() {}

const normalizeError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const WorktreeStateLive = Layer.scoped(
  WorktreeState,
  Effect.gen(function* () {
    let store: WorktreeStore | null = null

    yield* Effect.addFinalizer(() => {
      if (!store) return Effect.void
      return pipe(
        store.shutdown(),
        Effect.catchAll((error) => {
          console.warn('[chat] failed to close worktree store', { error: String(error) })
          return Effect.void
        }),
      )
    })

    const getStoreEffect = () =>
      Effect.try({
        try: () => {
          if (!store) store = createRedisWorktreeStore()
          return store
        },
        catch: (error) =>
          new WorktreeStateUnavailableError(
            error instanceof Error ? error.message : 'Worktree store is not configured',
          ),
      })

    const service: WorktreeStateService = {
      getWorktreeName: (chatId) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((worktreeStore) => worktreeStore.getWorktreeName(chatId)),
          Effect.mapError((error) =>
            error instanceof WorktreeStateUnavailableError ? error : normalizeError('worktree lookup failed', error),
          ),
        ),
      setWorktreeName: (chatId, worktreeName) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((worktreeStore) => worktreeStore.setWorktreeName(chatId, worktreeName)),
          Effect.mapError((error) =>
            error instanceof WorktreeStateUnavailableError ? error : normalizeError('worktree write failed', error),
          ),
        ),
      clearWorktree: (chatId) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((worktreeStore) => worktreeStore.clearWorktree(chatId)),
          Effect.mapError((error) =>
            error instanceof WorktreeStateUnavailableError ? error : normalizeError('worktree clear failed', error),
          ),
        ),
    }

    return service
  }),
)
