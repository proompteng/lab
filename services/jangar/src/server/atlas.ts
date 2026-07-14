import { Context, Effect, Layer, pipe } from 'effect'

import {
  type AtlasAstPreview,
  type AtlasCodeSearchHealth,
  type AtlasCodeSearchInput,
  type AtlasCodeSearchMatch,
  type AtlasIndexedFile,
  type AtlasStats,
  type AtlasStore,
  createPostgresAtlasStore,
  type FileKeyRecord,
  type FileVersionRecord,
  type GithubEventRecord,
  type RepositoryRecord,
  type UpsertGithubEventInput,
  type UpsertRepositoryInput,
} from './atlas-store'

export type AtlasService = {
  upsertRepository: (input: UpsertRepositoryInput) => Effect.Effect<RepositoryRecord, Error>
  getRepositoryByName: (input: { name: string }) => Effect.Effect<RepositoryRecord | null, Error>
  getFileKeyByPath: (input: { repositoryId: string; path: string }) => Effect.Effect<FileKeyRecord | null, Error>
  getFileVersionByKey: (input: {
    fileKeyId: string
    repositoryRef: string
    repositoryCommit?: string | null
    contentHash?: string | null
  }) => Effect.Effect<FileVersionRecord | null, Error>
  upsertGithubEvent: (input: UpsertGithubEventInput) => Effect.Effect<GithubEventRecord, Error>
  listIndexedFiles: (input: {
    limit?: number
    repository?: string
    ref?: string
    pathPrefix?: string
  }) => Effect.Effect<AtlasIndexedFile[], Error>
  getAstPreview: (input: { fileVersionId: string; limit?: number }) => Effect.Effect<AtlasAstPreview, Error>
  codeSearch: (input: AtlasCodeSearchInput) => Effect.Effect<AtlasCodeSearchMatch[], Error>
  codeSearchHealth: (
    input: Omit<AtlasCodeSearchInput, 'query' | 'limit'>,
  ) => Effect.Effect<AtlasCodeSearchHealth, Error>
  stats: () => Effect.Effect<AtlasStats, Error>
  close: () => Effect.Effect<void, Error>
}

export class Atlas extends Context.Tag('Atlas')<Atlas, AtlasService>() {}

const normalizeError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const AtlasLive = Layer.scoped(
  Atlas,
  Effect.gen(function* () {
    let store: ReturnType<typeof createPostgresAtlasStore> | null = null

    const getStore = () =>
      Effect.try({
        try: () => {
          if (!store) store = createPostgresAtlasStore()
          return store
        },
        catch: (error) => normalizeError('atlas store unavailable', error),
      })

    yield* Effect.addFinalizer(() => {
      const currentStore = store
      if (!currentStore) return Effect.void
      return pipe(
        Effect.tryPromise({
          try: () => currentStore.close(),
          catch: (error) => normalizeError('close atlas store', error),
        }),
        Effect.catchAll((error) => {
          console.warn('[mcp] failed to close atlas store', { error: String(error) })
          return Effect.void
        }),
      )
    })

    const wrap = <T>(message: string, action: (resolved: AtlasStore) => Promise<T>) =>
      pipe(
        getStore(),
        Effect.flatMap((resolved) =>
          Effect.tryPromise({
            try: () => action(resolved),
            catch: (error) => normalizeError(message, error),
          }),
        ),
      )

    const service: AtlasService = {
      upsertRepository: (input) => wrap('upsert repository failed', (resolved) => resolved.upsertRepository(input)),
      getRepositoryByName: (input) => wrap('get repository failed', (resolved) => resolved.getRepositoryByName(input)),
      getFileKeyByPath: (input) => wrap('get file key failed', (resolved) => resolved.getFileKeyByPath(input)),
      getFileVersionByKey: (input) =>
        wrap('get file version failed', (resolved) => resolved.getFileVersionByKey(input)),
      upsertGithubEvent: (input) => wrap('upsert github event failed', (resolved) => resolved.upsertGithubEvent(input)),
      listIndexedFiles: (input) =>
        wrap('atlas list indexed files failed', (resolved) => resolved.listIndexedFiles(input)),
      getAstPreview: (input) => wrap('atlas get ast preview failed', (resolved) => resolved.getAstPreview(input)),
      codeSearch: (input) => wrap('atlas code search failed', (resolved) => resolved.codeSearch(input)),
      codeSearchHealth: (input) =>
        wrap('atlas code search health failed', (resolved) => resolved.codeSearchHealth(input)),
      stats: () => wrap('atlas stats failed', (resolved) => resolved.stats()),
      close: () =>
        pipe(
          getStore(),
          Effect.flatMap((resolved) =>
            Effect.tryPromise({
              try: () => resolved.close(),
              catch: (error) => normalizeError('close atlas store', error),
            }),
          ),
        ),
    }

    return service
  }),
)
