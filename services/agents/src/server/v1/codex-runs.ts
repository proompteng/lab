import { Data, Effect } from 'effect'

import { errorResponse, okResponse } from '../http'
import { createCodexRunProjectionStore, type CodexRunProjectionStore } from '../codex-run-projection-store'

type CodexRunsStore = Pick<
  CodexRunProjectionStore,
  'ready' | 'close' | 'getRunHistory' | 'listIssueSummaries' | 'listRecentRuns' | 'listRunsPage'
>

export type CodexRunsApiDependencies = {
  storeFactory?: () => CodexRunsStore
}

class CodexRunsRequestError extends Data.TaggedError('CodexRunsRequestError')<{
  readonly message: string
  readonly status: 400
}> {}

class CodexRunsStorageError extends Data.TaggedError('CodexRunsStorageError')<{
  readonly operation: string
  readonly cause: unknown
}> {}

type CodexRunsError = CodexRunsRequestError | CodexRunsStorageError

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const parsePositiveInt = (value: string | null, max: number) => {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(parsed, max)
}

const openStore = (deps: CodexRunsApiDependencies = {}) =>
  Effect.try({
    try: () => (deps.storeFactory ?? createCodexRunProjectionStore)(),
    catch: (cause) => new CodexRunsStorageError({ operation: 'open-codex-run-projection-store', cause }),
  })

const readyStore = (store: CodexRunsStore) =>
  Effect.tryPromise({
    try: () => store.ready,
    catch: (cause) => new CodexRunsStorageError({ operation: 'ready-codex-run-projection-store', cause }),
  })

const closeStore = (store: CodexRunsStore) =>
  Effect.promise(() =>
    store.close().catch((error) => {
      console.warn('[agents] failed to close Codex run projection store', error)
    }),
  )

const requireRepository = (url: URL) => {
  const repository = url.searchParams.get('repository')?.trim() ?? ''
  if (!repository) {
    return Effect.fail(new CodexRunsRequestError({ message: 'repository is required', status: 400 }))
  }
  return Effect.succeed(repository)
}

const requireIssueNumber = (url: URL) => {
  const issueNumber =
    parsePositiveInt(url.searchParams.get('issueNumber'), Number.MAX_SAFE_INTEGER) ??
    parsePositiveInt(url.searchParams.get('issue_number'), Number.MAX_SAFE_INTEGER)
  if (!issueNumber) {
    return Effect.fail(new CodexRunsRequestError({ message: 'issueNumber is required', status: 400 }))
  }
  return Effect.succeed(issueNumber)
}

export const getCodexRunHistoryEffect = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const repository = yield* requireRepository(url)
    const issueNumber = yield* requireIssueNumber(url)
    const branch = url.searchParams.get('branch')?.trim() || undefined
    const limit = parsePositiveInt(url.searchParams.get('limit'), 100) ?? undefined

    return yield* Effect.acquireUseRelease(
      openStore(deps),
      (store) =>
        Effect.gen(function* () {
          yield* readyStore(store)
          const history = yield* Effect.tryPromise({
            try: () => store.getRunHistory({ repository, issueNumber, branch, limit }),
            catch: (cause) => new CodexRunsStorageError({ operation: 'get-codex-run-history', cause }),
          })
          return { ok: true, ...history }
        }),
      closeStore,
    )
  })

export const getCodexRecentRunsEffect = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const repository = url.searchParams.get('repository')?.trim() || undefined
    const limit = parsePositiveInt(url.searchParams.get('limit'), 200) ?? undefined

    return yield* Effect.acquireUseRelease(
      openStore(deps),
      (store) =>
        Effect.gen(function* () {
          yield* readyStore(store)
          const runs = yield* Effect.tryPromise({
            try: () => store.listRecentRuns({ repository, limit }),
            catch: (cause) => new CodexRunsStorageError({ operation: 'list-codex-recent-runs', cause }),
          })
          return { ok: true, runs }
        }),
      closeStore,
    )
  })

export const getCodexRunsPageEffect = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const repository = url.searchParams.get('repository')?.trim() || undefined
    const page = parsePositiveInt(url.searchParams.get('page'), Number.MAX_SAFE_INTEGER) ?? 1
    const pageSize = parsePositiveInt(url.searchParams.get('pageSize'), 200) ?? 50

    return yield* Effect.acquireUseRelease(
      openStore(deps),
      (store) =>
        Effect.gen(function* () {
          yield* readyStore(store)
          const result = yield* Effect.tryPromise({
            try: () => store.listRunsPage({ repository, page, pageSize }),
            catch: (cause) => new CodexRunsStorageError({ operation: 'list-codex-runs-page', cause }),
          })
          return { ok: true, runs: result.runs, total: result.total }
        }),
      closeStore,
    )
  })

export const getCodexIssuesEffect = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const repository = yield* requireRepository(url)
    const limit = parsePositiveInt(url.searchParams.get('limit'), 500) ?? undefined

    return yield* Effect.acquireUseRelease(
      openStore(deps),
      (store) =>
        Effect.gen(function* () {
          yield* readyStore(store)
          const issues = yield* Effect.tryPromise({
            try: () => store.listIssueSummaries(repository, limit),
            catch: (cause) => new CodexRunsStorageError({ operation: 'list-codex-issue-summaries', cause }),
          })
          return { ok: true, issues }
        }),
      closeStore,
    )
  })

const describeCodexRunsError = (error: CodexRunsError) => {
  if (error instanceof CodexRunsRequestError) return error.message
  return `Codex run projection ${error.operation} failed: ${toErrorMessage(error.cause)}`
}

const codexRunsStatus = (error: CodexRunsError) => {
  if (error instanceof CodexRunsRequestError) return error.status
  return toErrorMessage(error.cause).includes('DATABASE_URL') ? 503 : 500
}

const runHandler = async (effect: Effect.Effect<Record<string, unknown>, CodexRunsError>): Promise<Response> => {
  const result = await Effect.runPromise(effect.pipe(Effect.either))
  if (result._tag === 'Right') return okResponse(result.right)
  return errorResponse(describeCodexRunsError(result.left), codexRunsStatus(result.left))
}

export const getCodexRunHistoryHandler = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  runHandler(getCodexRunHistoryEffect(request, deps))

export const getCodexRecentRunsHandler = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  runHandler(getCodexRecentRunsEffect(request, deps))

export const getCodexRunsPageHandler = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  runHandler(getCodexRunsPageEffect(request, deps))

export const getCodexIssuesHandler = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  runHandler(getCodexIssuesEffect(request, deps))
