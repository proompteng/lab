import { Context, Effect, Layer, pipe } from 'effect'

import { createRedisWorktreeStore, type WorktreeStore } from './openwebui-worktree-store'

export class OpenWebUiWorktreeStateUnavailableError extends Error {
  readonly _tag = 'OpenWebUiWorktreeStateUnavailableError'
}

export type OpenWebUiWorktreeStateService = {
  getWorktreeName: (chatId: string) => Effect.Effect<string | null, Error>
  setWorktreeName: (chatId: string, worktreeName: string) => Effect.Effect<void, Error>
  clearWorktree: (chatId: string) => Effect.Effect<void, Error>
}

export class OpenWebUiWorktreeState extends Context.Tag('OpenWebUiWorktreeState')<
  OpenWebUiWorktreeState,
  OpenWebUiWorktreeStateService
>() {}

const normalizeError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const OpenWebUiWorktreeStateLive = Layer.scoped(
  OpenWebUiWorktreeState,
  Effect.gen(function* () {
    let store: WorktreeStore | null = null

    yield* Effect.addFinalizer(() => {
      if (!store) return Effect.void
      return pipe(
        store.shutdown(),
        Effect.catchAll((error) => {
          console.warn('[chat] failed to close OpenWebUI worktree store', { error: String(error) })
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
          new OpenWebUiWorktreeStateUnavailableError(
            error instanceof Error ? error.message : 'OpenWebUI worktree store is not configured',
          ),
      })

    const service: OpenWebUiWorktreeStateService = {
      getWorktreeName: (chatId) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((worktreeStore) => worktreeStore.getWorktreeName(chatId)),
          Effect.mapError((error) =>
            error instanceof OpenWebUiWorktreeStateUnavailableError
              ? error
              : normalizeError('worktree lookup failed', error),
          ),
        ),
      setWorktreeName: (chatId, worktreeName) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((worktreeStore) => worktreeStore.setWorktreeName(chatId, worktreeName)),
          Effect.mapError((error) =>
            error instanceof OpenWebUiWorktreeStateUnavailableError
              ? error
              : normalizeError('worktree write failed', error),
          ),
        ),
      clearWorktree: (chatId) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((worktreeStore) => worktreeStore.clearWorktree(chatId)),
          Effect.mapError((error) =>
            error instanceof OpenWebUiWorktreeStateUnavailableError
              ? error
              : normalizeError('worktree clear failed', error),
          ),
        ),
    }

    return service
  }),
)
