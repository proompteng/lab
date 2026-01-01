import { Context, Effect, Layer, pipe } from 'effect'

import {
  type AtlasAstPreview,
  type AtlasIndexedFile,
  type AtlasSearchInput,
  type AtlasSearchMatch,
  type AtlasStats,
  type AtlasStore,
  createPostgresAtlasStore,
  type EmbeddingRecord,
  type EnrichmentRecord,
  type EventFileRecord,
  type FileChunkRecord,
  type FileEdgeRecord,
  type FileKeyRecord,
  type FileVersionRecord,
  type GithubEventRecord,
  type IngestionRecord,
  type IngestionTargetRecord,
  type RepositoryRecord,
  type SymbolDefRecord,
  type SymbolRecord,
  type SymbolRefRecord,
  type TreeSitterFactRecord,
  type UpsertEmbeddingInput,
  type UpsertEnrichmentInput,
  type UpsertEventFileInput,
  type UpsertFileChunkInput,
  type UpsertFileEdgeInput,
  type UpsertFileKeyInput,
  type UpsertFileVersionInput,
  type UpsertGithubEventInput,
  type UpsertIngestionInput,
  type UpsertIngestionTargetInput,
  type UpsertRepositoryInput,
  type UpsertSymbolDefInput,
  type UpsertSymbolInput,
  type UpsertSymbolRefInput,
  type UpsertTreeSitterFactInput,
} from './atlas-store'

export type AtlasService = {
  upsertRepository: (input: UpsertRepositoryInput) => Effect.Effect<RepositoryRecord, Error>
  getRepositoryByName: (input: { name: string }) => Effect.Effect<RepositoryRecord | null, Error>
  upsertFileKey: (input: UpsertFileKeyInput) => Effect.Effect<FileKeyRecord, Error>
  getFileKeyByPath: (input: { repositoryId: string; path: string }) => Effect.Effect<FileKeyRecord | null, Error>
  upsertFileVersion: (input: UpsertFileVersionInput) => Effect.Effect<FileVersionRecord, Error>
  getFileVersionByKey: (input: {
    fileKeyId: string
    repositoryRef: string
    repositoryCommit?: string | null
    contentHash?: string | null
  }) => Effect.Effect<FileVersionRecord | null, Error>
  upsertFileChunk: (input: UpsertFileChunkInput) => Effect.Effect<FileChunkRecord, Error>
  upsertEnrichment: (input: UpsertEnrichmentInput) => Effect.Effect<EnrichmentRecord, Error>
  upsertEmbedding: (input: UpsertEmbeddingInput) => Effect.Effect<EmbeddingRecord, Error>
  upsertTreeSitterFact: (input: UpsertTreeSitterFactInput) => Effect.Effect<TreeSitterFactRecord, Error>
  upsertSymbol: (input: UpsertSymbolInput) => Effect.Effect<SymbolRecord, Error>
  upsertSymbolDef: (input: UpsertSymbolDefInput) => Effect.Effect<SymbolDefRecord, Error>
  upsertSymbolRef: (input: UpsertSymbolRefInput) => Effect.Effect<SymbolRefRecord, Error>
  upsertFileEdge: (input: UpsertFileEdgeInput) => Effect.Effect<FileEdgeRecord, Error>
  upsertGithubEvent: (input: UpsertGithubEventInput) => Effect.Effect<GithubEventRecord, Error>
  upsertIngestion: (input: UpsertIngestionInput) => Effect.Effect<IngestionRecord, Error>
  upsertEventFile: (input: UpsertEventFileInput) => Effect.Effect<EventFileRecord, Error>
  upsertIngestionTarget: (input: UpsertIngestionTargetInput) => Effect.Effect<IngestionTargetRecord, Error>
  listIndexedFiles: (input: {
    limit?: number
    repository?: string
    ref?: string
    pathPrefix?: string
  }) => Effect.Effect<AtlasIndexedFile[], Error>
  getAstPreview: (input: { fileVersionId: string; limit?: number }) => Effect.Effect<AtlasAstPreview, Error>
  search: (input: AtlasSearchInput) => Effect.Effect<AtlasSearchMatch[], Error>
  searchCount: (input: AtlasSearchInput) => Effect.Effect<number, Error>
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
      upsertFileKey: (input) => wrap('upsert file key failed', (resolved) => resolved.upsertFileKey(input)),
      getFileKeyByPath: (input) => wrap('get file key failed', (resolved) => resolved.getFileKeyByPath(input)),
      upsertFileVersion: (input) => wrap('upsert file version failed', (resolved) => resolved.upsertFileVersion(input)),
      getFileVersionByKey: (input) =>
        wrap('get file version failed', (resolved) => resolved.getFileVersionByKey(input)),
      upsertFileChunk: (input) => wrap('upsert file chunk failed', (resolved) => resolved.upsertFileChunk(input)),
      upsertEnrichment: (input) => wrap('upsert enrichment failed', (resolved) => resolved.upsertEnrichment(input)),
      upsertEmbedding: (input) => wrap('upsert embedding failed', (resolved) => resolved.upsertEmbedding(input)),
      upsertTreeSitterFact: (input) =>
        wrap('upsert tree sitter fact failed', (resolved) => resolved.upsertTreeSitterFact(input)),
      upsertSymbol: (input) => wrap('upsert symbol failed', (resolved) => resolved.upsertSymbol(input)),
      upsertSymbolDef: (input) => wrap('upsert symbol def failed', (resolved) => resolved.upsertSymbolDef(input)),
      upsertSymbolRef: (input) => wrap('upsert symbol ref failed', (resolved) => resolved.upsertSymbolRef(input)),
      upsertFileEdge: (input) => wrap('upsert file edge failed', (resolved) => resolved.upsertFileEdge(input)),
      upsertGithubEvent: (input) => wrap('upsert github event failed', (resolved) => resolved.upsertGithubEvent(input)),
      upsertIngestion: (input) => wrap('upsert ingestion failed', (resolved) => resolved.upsertIngestion(input)),
      upsertEventFile: (input) => wrap('upsert event file failed', (resolved) => resolved.upsertEventFile(input)),
      upsertIngestionTarget: (input) =>
        wrap('upsert ingestion target failed', (resolved) => resolved.upsertIngestionTarget(input)),
      listIndexedFiles: (input) =>
        wrap('atlas list indexed files failed', (resolved) => resolved.listIndexedFiles(input)),
      getAstPreview: (input) => wrap('atlas get ast preview failed', (resolved) => resolved.getAstPreview(input)),
      search: (input) => wrap('atlas search failed', (resolved) => resolved.search(input)),
      searchCount: (input) => wrap('atlas search count failed', (resolved) => resolved.searchCount(input)),
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
