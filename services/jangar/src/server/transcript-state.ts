import { Context, Effect, Layer, pipe } from 'effect'
import type { TranscriptEntry } from './chat-transcript'
import { type ChatTranscriptStore, createRedisChatTranscriptStore } from './chat-transcript-store'

export class TranscriptStateUnavailableError extends Error {
  readonly _tag = 'TranscriptStateUnavailableError'
}

export type TranscriptStateService = {
  getTranscript: (chatId: string) => Effect.Effect<TranscriptEntry[] | null, Error>
  setTranscript: (chatId: string, signature: TranscriptEntry[]) => Effect.Effect<void, Error>
  clearTranscript: (chatId: string) => Effect.Effect<void, Error>
}

export class TranscriptState extends Context.Tag('TranscriptState')<TranscriptState, TranscriptStateService>() {}

const normalizeError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const TranscriptStateLive = Layer.scoped(
  TranscriptState,
  Effect.gen(function* () {
    let store: ChatTranscriptStore | null = null

    yield* Effect.addFinalizer(() => {
      if (!store) return Effect.void
      return pipe(
        store.shutdown(),
        Effect.catchAll((error) => {
          console.warn('[chat] failed to close transcript store', { error: String(error) })
          return Effect.void
        }),
      )
    })

    const getStoreEffect = () =>
      Effect.try({
        try: () => {
          if (!store) store = createRedisChatTranscriptStore()
          return store
        },
        catch: (error) =>
          new TranscriptStateUnavailableError(
            error instanceof Error ? error.message : 'Transcript store is not configured',
          ),
      })

    const service: TranscriptStateService = {
      getTranscript: (chatId) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((transcriptStore) => transcriptStore.getTranscript(chatId)),
          Effect.mapError((error) =>
            error instanceof TranscriptStateUnavailableError
              ? error
              : normalizeError('transcript lookup failed', error),
          ),
        ),
      setTranscript: (chatId, signature) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((transcriptStore) => transcriptStore.setTranscript(chatId, signature)),
          Effect.mapError((error) =>
            error instanceof TranscriptStateUnavailableError ? error : normalizeError('transcript write failed', error),
          ),
        ),
      clearTranscript: (chatId) =>
        pipe(
          getStoreEffect(),
          Effect.flatMap((transcriptStore) => transcriptStore.clearTranscript(chatId)),
          Effect.mapError((error) =>
            error instanceof TranscriptStateUnavailableError ? error : normalizeError('transcript clear failed', error),
          ),
        ),
    }

    return service
  }),
)
