import { Context, Effect, Layer, pipe } from 'effect'

import { type ChatThreadStore, createRedisChatThreadStore } from './chat-thread-store'

export class OpenWebUiThreadStateUnavailableError extends Error {
  readonly _tag = 'OpenWebUiThreadStateUnavailableError'
}

export type OpenWebUiThreadStateService = {
  getThreadId: (chatId: string) => Effect.Effect<string | null, Error>
  setThreadId: (chatId: string, threadId: string) => Effect.Effect<void, Error>
  nextTurn: (chatId: string) => Effect.Effect<number, Error>
  clearChat: (chatId: string) => Effect.Effect<void, Error>
}

export class OpenWebUiThreadState extends Context.Tag('OpenWebUiThreadState')<
  OpenWebUiThreadState,
  OpenWebUiThreadStateService
>() {}

const normalizeError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const OpenWebUiThreadStateLive = Layer.scoped(
  OpenWebUiThreadState,
  Effect.gen(function* () {
    let store: ChatThreadStore | null = null

    yield* Effect.addFinalizer(() => {
      if (!store) return Effect.void
      return pipe(
        store.shutdown(),
        Effect.catchAll((error) => {
          console.warn('[chat] failed to close OpenWebUI thread store', { error: String(error) })
          return Effect.void
        }),
      )
    })

    const getStoreEffect = () =>
      Effect.try({
        try: () => {
          if (!store) store = createRedisChatThreadStore()
          return store
        },
        catch: (error) =>
          new OpenWebUiThreadStateUnavailableError(
            error instanceof Error ? error.message : 'OpenWebUI thread store is not configured',
          ),
      })

    const service: OpenWebUiThreadStateService = {
      getThreadId: (chatId) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((threadStore) => threadStore.getThread(chatId)),
          Effect.mapError((error) =>
            error instanceof OpenWebUiThreadStateUnavailableError
              ? error
              : normalizeError('thread lookup failed', error),
          ),
        ),
      setThreadId: (chatId, threadId) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((threadStore) => threadStore.setThread(chatId, threadId)),
          Effect.mapError((error) =>
            error instanceof OpenWebUiThreadStateUnavailableError
              ? error
              : normalizeError('thread write failed', error),
          ),
        ),
      nextTurn: (chatId) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((threadStore) => threadStore.nextTurn(chatId)),
          Effect.mapError((error) =>
            error instanceof OpenWebUiThreadStateUnavailableError
              ? error
              : normalizeError('turn increment failed', error),
          ),
        ),
      clearChat: (chatId) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((threadStore) => threadStore.clearThread(chatId)),
          Effect.mapError((error) =>
            error instanceof OpenWebUiThreadStateUnavailableError
              ? error
              : normalizeError('thread clear failed', error),
          ),
        ),
    }

    return service
  }),
)
