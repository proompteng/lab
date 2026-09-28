import { Context, Data, Effect, Layer } from 'effect'

import {
  createCodexRunProjectionStore,
  type AttachNotifyInput,
  type CodexArtifactRecord,
  type CodexEvaluationRecord,
  type CodexIssueSummaryRecord,
  type CodexPendingRun,
  type CodexRunHistory,
  type CodexRunProjectionStore,
  type CodexRunRecord,
  type CodexRunSummaryRecord,
  type GetRunHistoryInput,
  type ListRecentRunsInput,
  type ListRunsPageInput,
  type ListRunsPageResult,
  type UpdateCiInput,
  type UpdateDecisionInput,
  type UpdateReviewInput,
  type UpsertArtifactsInput,
  type UpsertRunCompleteInput,
} from '../codex-run-projection-store'
import { classifyStorageFailure, toErrorMessage, type StorageFailureCauseCode } from '../storage-error-classification'

export type CodexRunProjectionStoreFactory = () => CodexRunProjectionStore

export type CodexRunProjectionOperation =
  | 'open-codex-run-projection-store'
  | 'ready-codex-run-projection-store'
  | 'close-codex-run-projection-store'
  | 'attach-codex-notify-projection'
  | 'get-codex-run-by-agent-run'
  | 'get-codex-run-by-id'
  | 'get-codex-run-history'
  | 'list-codex-artifacts-for-run'
  | 'list-codex-issue-summaries'
  | 'list-codex-recent-runs'
  | 'list-codex-runs-by-branch'
  | 'list-codex-runs-by-commit'
  | 'list-codex-runs-by-pr'
  | 'list-codex-runs-by-status'
  | 'list-codex-runs-page'
  | 'lookup-codex-run-projection'
  | 'update-codex-ci-projection'
  | 'update-codex-decision-projection'
  | 'update-codex-pr-projection'
  | 'update-codex-review-projection'
  | 'update-codex-run-prompt'
  | 'update-codex-run-status'
  | 'upsert-codex-artifact-projection'
  | 'upsert-codex-run-complete-projection'

export class CodexRunProjectionStorageError extends Data.TaggedError('CodexRunProjectionStorageError')<{
  readonly operation: CodexRunProjectionOperation
  readonly message: string
  readonly cause: unknown
  readonly causeCode: StorageFailureCauseCode
  readonly retryable: boolean
  readonly httpStatusCode: 500 | 503
}> {}

export type CodexRunProjectionStoreServiceDefinition = {
  readonly open: Effect.Effect<CodexRunProjectionStore, CodexRunProjectionStorageError>
  readonly ready: (store: CodexRunProjectionStore) => Effect.Effect<void, CodexRunProjectionStorageError>
  readonly attachNotify: (
    store: CodexRunProjectionStore,
    input: AttachNotifyInput,
  ) => Effect.Effect<CodexRunRecord | null, CodexRunProjectionStorageError>
  readonly getRunByAgentRun: (
    store: CodexRunProjectionStore,
    agentRunName: string,
    namespace?: string | null,
  ) => Effect.Effect<CodexRunRecord | null, CodexRunProjectionStorageError>
  readonly getRunById: (
    store: CodexRunProjectionStore,
    runId: string,
  ) => Effect.Effect<CodexRunRecord | null, CodexRunProjectionStorageError>
  readonly getRunHistory: (
    store: CodexRunProjectionStore,
    input: GetRunHistoryInput,
  ) => Effect.Effect<CodexRunHistory, CodexRunProjectionStorageError>
  readonly listArtifactsForRun: (
    store: CodexRunProjectionStore,
    runId: string,
  ) => Effect.Effect<CodexArtifactRecord[], CodexRunProjectionStorageError>
  readonly listIssueSummaries: (
    store: CodexRunProjectionStore,
    repository: string,
    limit?: number,
  ) => Effect.Effect<CodexIssueSummaryRecord[], CodexRunProjectionStorageError>
  readonly listRecentRuns: (
    store: CodexRunProjectionStore,
    input: ListRecentRunsInput,
  ) => Effect.Effect<CodexRunSummaryRecord[], CodexRunProjectionStorageError>
  readonly listRunsByBranch: (
    store: CodexRunProjectionStore,
    repository: string,
    branch: string,
  ) => Effect.Effect<CodexRunRecord[], CodexRunProjectionStorageError>
  readonly listRunsByCommitSha: (
    store: CodexRunProjectionStore,
    repository: string,
    commitSha: string,
  ) => Effect.Effect<CodexRunRecord[], CodexRunProjectionStorageError>
  readonly listRunsByPrNumber: (
    store: CodexRunProjectionStore,
    repository: string,
    prNumber: number,
  ) => Effect.Effect<CodexRunRecord[], CodexRunProjectionStorageError>
  readonly listRunsByStatus: (
    store: CodexRunProjectionStore,
    statuses: string[],
  ) => Effect.Effect<CodexPendingRun[], CodexRunProjectionStorageError>
  readonly listRunsPage: (
    store: CodexRunProjectionStore,
    input: ListRunsPageInput,
  ) => Effect.Effect<ListRunsPageResult, CodexRunProjectionStorageError>
  readonly updateCiStatus: (
    store: CodexRunProjectionStore,
    input: UpdateCiInput,
  ) => Effect.Effect<CodexRunRecord | null, CodexRunProjectionStorageError>
  readonly updateDecision: (
    store: CodexRunProjectionStore,
    input: UpdateDecisionInput,
  ) => Effect.Effect<CodexEvaluationRecord, CodexRunProjectionStorageError>
  readonly updateReviewStatus: (
    store: CodexRunProjectionStore,
    input: UpdateReviewInput,
  ) => Effect.Effect<CodexRunRecord | null, CodexRunProjectionStorageError>
  readonly updateRunPrInfo: (
    store: CodexRunProjectionStore,
    runId: string,
    prNumber: number,
    prUrl: string,
    commitSha?: string | null,
    prState?: string | null,
    prMerged?: boolean | null,
  ) => Effect.Effect<CodexRunRecord | null, CodexRunProjectionStorageError>
  readonly updateRunPrompt: (
    store: CodexRunProjectionStore,
    runId: string,
    prompt: string | null,
    nextPrompt?: string | null,
  ) => Effect.Effect<CodexRunRecord | null, CodexRunProjectionStorageError>
  readonly updateRunStatus: (
    store: CodexRunProjectionStore,
    runId: string,
    status: string,
  ) => Effect.Effect<CodexRunRecord | null, CodexRunProjectionStorageError>
  readonly upsertArtifacts: (
    store: CodexRunProjectionStore,
    input: UpsertArtifactsInput,
  ) => Effect.Effect<CodexArtifactRecord[], CodexRunProjectionStorageError>
  readonly upsertRunComplete: (
    store: CodexRunProjectionStore,
    input: UpsertRunCompleteInput,
  ) => Effect.Effect<CodexRunRecord, CodexRunProjectionStorageError>
  readonly close: (store: CodexRunProjectionStore) => Effect.Effect<void>
}

export class CodexRunProjectionStoreService extends Context.Tag('agents/CodexRunProjectionStoreService')<
  CodexRunProjectionStoreService,
  CodexRunProjectionStoreServiceDefinition
>() {}

export const codexRunProjectionStoreEffect = <A>(
  operation: CodexRunProjectionOperation,
  run: () => Promise<A>,
): Effect.Effect<A, CodexRunProjectionStorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const classified = classifyStorageFailure(cause)
      return new CodexRunProjectionStorageError({ operation, cause, ...classified })
    },
  })

export const waitForCodexRunProjectionStoreReadyEffect = (store: CodexRunProjectionStore) =>
  codexRunProjectionStoreEffect('ready-codex-run-projection-store', () =>
    Promise.resolve(store.ready).then(() => undefined),
  )

export const closeCodexRunProjectionStoreEffect = (store: CodexRunProjectionStore) =>
  codexRunProjectionStoreEffect('close-codex-run-projection-store', () => store.close()).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.warn('[agents] failed to close Codex run projection store', error)
      }),
    ),
  )

export const makeCodexRunProjectionStoreService = (
  storeFactory: CodexRunProjectionStoreFactory = createCodexRunProjectionStore,
): CodexRunProjectionStoreServiceDefinition => ({
  open: Effect.try({
    try: () => storeFactory(),
    catch: (cause) => {
      const classified = classifyStorageFailure(cause)
      return new CodexRunProjectionStorageError({
        operation: 'open-codex-run-projection-store',
        cause,
        ...classified,
      })
    },
  }),
  ready: waitForCodexRunProjectionStoreReadyEffect,
  attachNotify: (store, input) =>
    codexRunProjectionStoreEffect('attach-codex-notify-projection', () => store.attachNotify(input)),
  getRunByAgentRun: (store, agentRunName, namespace) =>
    codexRunProjectionStoreEffect('get-codex-run-by-agent-run', () => store.getRunByAgentRun(agentRunName, namespace)),
  getRunById: (store, runId) => codexRunProjectionStoreEffect('get-codex-run-by-id', () => store.getRunById(runId)),
  getRunHistory: (store, input) =>
    codexRunProjectionStoreEffect('get-codex-run-history', () => store.getRunHistory(input)),
  listArtifactsForRun: (store, runId) =>
    codexRunProjectionStoreEffect('list-codex-artifacts-for-run', () => store.listArtifactsForRun(runId)),
  listIssueSummaries: (store, repository, limit) =>
    codexRunProjectionStoreEffect('list-codex-issue-summaries', () => store.listIssueSummaries(repository, limit)),
  listRecentRuns: (store, input) =>
    codexRunProjectionStoreEffect('list-codex-recent-runs', () => store.listRecentRuns(input)),
  listRunsByBranch: (store, repository, branch) =>
    codexRunProjectionStoreEffect('list-codex-runs-by-branch', () => store.listRunsByBranch(repository, branch)),
  listRunsByCommitSha: (store, repository, commitSha) =>
    codexRunProjectionStoreEffect('list-codex-runs-by-commit', () => store.listRunsByCommitSha(repository, commitSha)),
  listRunsByPrNumber: (store, repository, prNumber) =>
    codexRunProjectionStoreEffect('list-codex-runs-by-pr', () => store.listRunsByPrNumber(repository, prNumber)),
  listRunsByStatus: (store, statuses) =>
    codexRunProjectionStoreEffect('list-codex-runs-by-status', () => store.listRunsByStatus(statuses)),
  listRunsPage: (store, input) =>
    codexRunProjectionStoreEffect('list-codex-runs-page', () => store.listRunsPage(input)),
  updateCiStatus: (store, input) =>
    codexRunProjectionStoreEffect('update-codex-ci-projection', () => store.updateCiStatus(input)),
  updateDecision: (store, input) =>
    codexRunProjectionStoreEffect('update-codex-decision-projection', () => store.updateDecision(input)),
  updateReviewStatus: (store, input) =>
    codexRunProjectionStoreEffect('update-codex-review-projection', () => store.updateReviewStatus(input)),
  updateRunPrInfo: (store, runId, prNumber, prUrl, commitSha, prState, prMerged) =>
    codexRunProjectionStoreEffect('update-codex-pr-projection', () =>
      store.updateRunPrInfo(runId, prNumber, prUrl, commitSha, prState, prMerged),
    ),
  updateRunPrompt: (store, runId, prompt, nextPrompt) =>
    codexRunProjectionStoreEffect('update-codex-run-prompt', () => store.updateRunPrompt(runId, prompt, nextPrompt)),
  updateRunStatus: (store, runId, status) =>
    codexRunProjectionStoreEffect('update-codex-run-status', () => store.updateRunStatus(runId, status)),
  upsertArtifacts: (store, input) =>
    codexRunProjectionStoreEffect('upsert-codex-artifact-projection', () => store.upsertArtifacts(input)),
  upsertRunComplete: (store, input) =>
    codexRunProjectionStoreEffect('upsert-codex-run-complete-projection', () => store.upsertRunComplete(input)),
  close: closeCodexRunProjectionStoreEffect,
})

export const makeCodexRunProjectionStoreLayer = (storeFactory?: CodexRunProjectionStoreFactory) =>
  Layer.succeed(CodexRunProjectionStoreService, makeCodexRunProjectionStoreService(storeFactory))

export const CodexRunProjectionStoreLive = makeCodexRunProjectionStoreLayer()

export const describeCodexRunProjectionStorageError = (error: CodexRunProjectionStorageError) =>
  `Codex run projection ${error.operation} failed: ${error.message || toErrorMessage(error.cause)}`
