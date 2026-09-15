import { Data, Effect } from 'effect'

import { type CodexRunProjectionStore } from '../codex-run-projection-store'
import { errorResponse, okResponse } from '../http'

import {
  CodexRunProjectionStorageError,
  CodexRunProjectionStoreService,
  type CodexRunProjectionStoreServiceDefinition,
  describeCodexRunProjectionStorageError,
  makeCodexRunProjectionStoreLayer,
} from './codex-run-projection-store'

type CodexRunsStore = Pick<
  CodexRunProjectionStore,
  | 'ready'
  | 'close'
  | 'getRunById'
  | 'getRunHistory'
  | 'listIssueSummaries'
  | 'listRecentRuns'
  | 'listRunsByPrNumber'
  | 'listRunsPage'
>

export type CodexRunsApiDependencies = {
  storeFactory?: () => CodexRunsStore
}

class CodexRunsRequestError extends Data.TaggedError('CodexRunsRequestError')<{
  readonly message: string
  readonly status: 400
}> {}

type CodexRunsError = CodexRunsRequestError | CodexRunProjectionStorageError

const parsePositiveInt = (value: string | null, max: number) => {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(parsed, max)
}

const requireRepository = (url: URL) => {
  const repository = url.searchParams.get('repository')?.trim() ?? ''
  if (!repository) {
    return Effect.fail(new CodexRunsRequestError({ message: 'repository is required', status: 400 }))
  }
  return Effect.succeed(repository)
}

const requireRunId = (url: URL) => {
  const runId = url.searchParams.get('runId')?.trim() ?? url.searchParams.get('run_id')?.trim() ?? ''
  if (!runId) {
    return Effect.fail(new CodexRunsRequestError({ message: 'runId is required', status: 400 }))
  }
  return Effect.succeed(runId)
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

const requirePrNumber = (url: URL) => {
  const prNumber =
    parsePositiveInt(url.searchParams.get('prNumber'), Number.MAX_SAFE_INTEGER) ??
    parsePositiveInt(url.searchParams.get('pr_number'), Number.MAX_SAFE_INTEGER)
  if (!prNumber) {
    return Effect.fail(new CodexRunsRequestError({ message: 'prNumber is required', status: 400 }))
  }
  return Effect.succeed(prNumber)
}

const withCodexRunProjectionStore = <A>(
  run: (
    store: CodexRunProjectionStore,
    stores: CodexRunProjectionStoreServiceDefinition,
  ) => Effect.Effect<A, CodexRunProjectionStorageError>,
): Effect.Effect<A, CodexRunProjectionStorageError, CodexRunProjectionStoreService> =>
  Effect.gen(function* () {
    const stores = yield* CodexRunProjectionStoreService
    return yield* Effect.acquireUseRelease(
      stores.open,
      (store) => stores.ready(store).pipe(Effect.zipRight(run(store, stores))),
      stores.close,
    )
  })

export const getCodexRunByIdWithServicesEffect = (
  request: Request,
): Effect.Effect<Record<string, unknown>, CodexRunsError, CodexRunProjectionStoreService> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const runId = yield* requireRunId(url)
    return yield* withCodexRunProjectionStore((store, stores) =>
      stores.getRunById(store, runId).pipe(Effect.map((run) => ({ ok: true, run }))),
    )
  })

export const getCodexRunHistoryWithServicesEffect = (
  request: Request,
): Effect.Effect<Record<string, unknown>, CodexRunsError, CodexRunProjectionStoreService> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const repository = yield* requireRepository(url)
    const issueNumber = yield* requireIssueNumber(url)
    const branch = url.searchParams.get('branch')?.trim() || undefined
    const limit = parsePositiveInt(url.searchParams.get('limit'), 100) ?? undefined

    return yield* withCodexRunProjectionStore((store, stores) =>
      stores
        .getRunHistory(store, { repository, issueNumber, branch, limit })
        .pipe(Effect.map((history) => ({ ok: true, ...history }))),
    )
  })

export const getCodexRunsByPrWithServicesEffect = (
  request: Request,
): Effect.Effect<Record<string, unknown>, CodexRunsError, CodexRunProjectionStoreService> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const repository = yield* requireRepository(url)
    const prNumber = yield* requirePrNumber(url)
    return yield* withCodexRunProjectionStore((store, stores) =>
      stores.listRunsByPrNumber(store, repository, prNumber).pipe(Effect.map((runs) => ({ ok: true, runs }))),
    )
  })

export const getCodexRecentRunsWithServicesEffect = (
  request: Request,
): Effect.Effect<Record<string, unknown>, CodexRunsError, CodexRunProjectionStoreService> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const repository = url.searchParams.get('repository')?.trim() || undefined
    const limit = parsePositiveInt(url.searchParams.get('limit'), 200) ?? undefined
    return yield* withCodexRunProjectionStore((store, stores) =>
      stores.listRecentRuns(store, { repository, limit }).pipe(Effect.map((runs) => ({ ok: true, runs }))),
    )
  })

export const getCodexRunsPageWithServicesEffect = (
  request: Request,
): Effect.Effect<Record<string, unknown>, CodexRunsError, CodexRunProjectionStoreService> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const repository = url.searchParams.get('repository')?.trim() || undefined
    const page = parsePositiveInt(url.searchParams.get('page'), Number.MAX_SAFE_INTEGER) ?? 1
    const pageSize = parsePositiveInt(url.searchParams.get('pageSize'), 200) ?? 50

    return yield* withCodexRunProjectionStore((store, stores) =>
      stores
        .listRunsPage(store, { repository, page, pageSize })
        .pipe(Effect.map((result) => ({ ok: true, runs: result.runs, total: result.total }))),
    )
  })

export const getCodexIssuesWithServicesEffect = (
  request: Request,
): Effect.Effect<Record<string, unknown>, CodexRunsError, CodexRunProjectionStoreService> =>
  Effect.gen(function* () {
    const url = new URL(request.url)
    const repository = yield* requireRepository(url)
    const limit = parsePositiveInt(url.searchParams.get('limit'), 500) ?? undefined
    return yield* withCodexRunProjectionStore((store, stores) =>
      stores.listIssueSummaries(store, repository, limit).pipe(Effect.map((issues) => ({ ok: true, issues }))),
    )
  })

const provideCodexProjectionStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | CodexRunProjectionStoreService>,
  deps: CodexRunsApiDependencies = {},
) =>
  effect.pipe(
    Effect.provide(makeCodexRunProjectionStoreLayer(deps.storeFactory as (() => CodexRunProjectionStore) | undefined)),
  )

export const getCodexRunByIdEffect = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  provideCodexProjectionStore(getCodexRunByIdWithServicesEffect(request), deps)

export const getCodexRunHistoryEffect = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  provideCodexProjectionStore(getCodexRunHistoryWithServicesEffect(request), deps)

export const getCodexRunsByPrEffect = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  provideCodexProjectionStore(getCodexRunsByPrWithServicesEffect(request), deps)

export const getCodexRecentRunsEffect = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  provideCodexProjectionStore(getCodexRecentRunsWithServicesEffect(request), deps)

export const getCodexRunsPageEffect = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  provideCodexProjectionStore(getCodexRunsPageWithServicesEffect(request), deps)

export const getCodexIssuesEffect = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  provideCodexProjectionStore(getCodexIssuesWithServicesEffect(request), deps)

const describeCodexRunsError = (error: CodexRunsError) => {
  if (error instanceof CodexRunsRequestError) return error.message
  return describeCodexRunProjectionStorageError(error)
}

const codexRunsStatus = (error: CodexRunsError) => {
  if (error instanceof CodexRunsRequestError) return error.status
  return error.httpStatusCode
}

const runHandler = async (effect: Effect.Effect<Record<string, unknown>, CodexRunsError>): Promise<Response> => {
  const result = await Effect.runPromise(effect.pipe(Effect.either))
  if (result._tag === 'Right') return okResponse(result.right)
  return errorResponse(describeCodexRunsError(result.left), codexRunsStatus(result.left))
}

export const getCodexRunHistoryHandler = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  runHandler(getCodexRunHistoryEffect(request, deps))

export const getCodexRunByIdHandler = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  runHandler(getCodexRunByIdEffect(request, deps))

export const getCodexRunsByPrHandler = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  runHandler(getCodexRunsByPrEffect(request, deps))

export const getCodexRecentRunsHandler = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  runHandler(getCodexRecentRunsEffect(request, deps))

export const getCodexRunsPageHandler = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  runHandler(getCodexRunsPageEffect(request, deps))

export const getCodexIssuesHandler = (request: Request, deps: CodexRunsApiDependencies = {}) =>
  runHandler(getCodexIssuesEffect(request, deps))
