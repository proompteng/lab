import { sql } from 'kysely'

import { createKyselyDb, type Db, getDb } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

export type GithubCheckRun = {
  id: string
  name: string | null
  status: string | null
  conclusion: string | null
  url: string | null
  completedAt: string | null
}

export type GithubCheckSummary = {
  status: string | null
  detailsUrl: string | null
  totalCount: number
  successCount: number
  failureCount: number
  pendingCount: number
  runs: GithubCheckRun[]
}

export type GithubReviewSummary = {
  decision: string | null
  requestedChanges: boolean | null
  unresolvedThreadsCount: number
  latestReviewedAt: string | null
}

export type GithubPullState = {
  repository: string
  number: number
  title: string | null
  body: string | null
  state: string | null
  merged: boolean | null
  mergedAt: string | null
  draft: boolean | null
  authorLogin: string | null
  authorAvatarUrl: string | null
  htmlUrl: string | null
  headRef: string | null
  headSha: string | null
  baseRef: string | null
  baseSha: string | null
  mergeable: boolean | null
  mergeableState: string | null
  labels: string[]
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  createdAt: string | null
  updatedAt: string | null
  receivedAt: string
}

export type GithubPullListItem = GithubPullState & {
  review: GithubReviewSummary | null
  checks: GithubCheckSummary | null
}

export type GithubReviewThread = {
  threadKey: string
  threadId: string | null
  isResolved: boolean
  path: string | null
  line: number | null
  side: string | null
  startLine: number | null
  authorLogin: string | null
  createdAt: string | null
  updatedAt: string | null
  comments: GithubReviewComment[]
}

export type GithubReviewComment = {
  commentId: string
  authorLogin: string | null
  body: string | null
  createdAt: string | null
  updatedAt: string | null
  path: string | null
  line: number | null
  side: string | null
  startLine: number | null
  diffHunk: string | null
  url: string | null
}

export type GithubIssueComment = {
  commentId: string
  authorLogin: string | null
  body: string | null
  createdAt: string | null
  updatedAt: string | null
  url: string | null
}

export type GithubPrFile = {
  path: string
  source?: string | null
  status: string | null
  additions: number | null
  deletions: number | null
  changes: number | null
  patch: string | null
  blobUrl: string | null
  rawUrl: string | null
  sha: string | null
  previousFilename: string | null
}

export type GithubCheckState = {
  commitSha: string
  status: string | null
  detailsUrl: string | null
  totalCount: number
  successCount: number
  failureCount: number
  pendingCount: number
  runs: GithubCheckRun[]
  updatedAt: string | null
}

export type GithubPrWorktree = {
  repository: string
  prNumber: number
  worktreeName: string
  worktreePath: string
  baseSha: string | null
  headSha: string | null
  lastRefreshedAt: string
}

export type GithubWriteAudit = {
  repository: string
  prNumber: number
  commitSha: string | null
  action: string
  actor: string | null
  requestId: string | null
  payload: Record<string, unknown>
  response?: Record<string, unknown> | null
  success: boolean
  error?: string | null
  receivedAt: string
}

export type GithubEventInsert = {
  deliveryId: string
  eventType: string
  action: string | null
  repository: string
  prNumber: number
  commitSha: string | null
  senderLogin: string | null
  payload: Record<string, unknown>
  receivedAt: string
}

export type GithubReviewStore = {
  ready: Promise<void>
  close: () => Promise<void>
  recordEvent: (input: GithubEventInsert) => Promise<{ inserted: boolean }>
  upsertPrState: (input: GithubPullState) => Promise<void>
  upsertReviewState: (
    input: GithubReviewSummary & { repository: string; prNumber: number; commitSha: string | null; receivedAt: string },
  ) => Promise<void>
  upsertCheckState: (input: {
    repository: string
    prNumber: number
    commitSha: string
    receivedAt: string
    check: GithubCheckRun
  }) => Promise<GithubCheckSummary>
  upsertReviewThread: (
    input: GithubReviewThread & { repository: string; prNumber: number; commitSha: string | null; receivedAt: string },
  ) => Promise<void>
  upsertReviewComment: (
    input: GithubReviewComment & {
      repository: string
      prNumber: number
      commitSha: string | null
      receivedAt: string
      threadKey: string | null
    },
  ) => Promise<void>
  upsertIssueComment: (
    input: GithubIssueComment & { repository: string; prNumber: number; commitSha: string | null; receivedAt: string },
  ) => Promise<void>
  upsertPrFiles: (input: {
    repository: string
    prNumber: number
    commitSha: string
    receivedAt: string
    files: GithubPrFile[]
    source?: string
  }) => Promise<void>
  replacePrFiles: (input: {
    repository: string
    prNumber: number
    commitSha: string
    receivedAt: string
    files: GithubPrFile[]
    source: string
  }) => Promise<void>
  upsertPrWorktree: (input: GithubPrWorktree) => Promise<void>
  getPrWorktree: (input: { repository: string; prNumber: number }) => Promise<GithubPrWorktree | null>
  getUnresolvedThreadCount: (input: { repository: string; prNumber: number }) => Promise<number>
  updateUnresolvedThreadCount: (input: {
    repository: string
    prNumber: number
    count: number
    receivedAt: string
  }) => Promise<void>
  listPulls: (input: {
    repositories?: string[]
    repository?: string
    state?: string
    author?: string
    label?: string
    reviewDecision?: string
    ciStatus?: string
    limit?: number
    cursor?: string | null
  }) => Promise<{ items: GithubPullListItem[]; nextCursor: string | null }>
  getPull: (input: { repository: string; prNumber: number }) => Promise<{
    pull: GithubPullState | null
    review: GithubReviewSummary | null
    checks: GithubCheckSummary | null
    issueComments: GithubIssueComment[]
  }>
  listFiles: (input: {
    repository: string
    prNumber: number
    commitSha: string | null
    source?: string | null
  }) => Promise<GithubPrFile[]>
  listCheckStates: (input: { repository: string; prNumber: number }) => Promise<GithubCheckState[]>
  listThreads: (input: { repository: string; prNumber: number }) => Promise<GithubReviewThread[]>
  updateThreadResolution: (input: {
    repository: string
    prNumber: number
    threadKey: string
    threadId?: string | null
    resolved: boolean
    receivedAt: string
  }) => Promise<void>
  updateMergeState: (input: {
    repository: string
    prNumber: number
    merged: boolean
    mergeableState?: string | null
    receivedAt: string
  }) => Promise<void>
  updateReviewDecision: (input: {
    repository: string
    prNumber: number
    decision: string
    requestedChanges: boolean
    receivedAt: string
  }) => Promise<void>
  insertWriteAudit: (input: GithubWriteAudit) => Promise<void>
  resolveThreadKey: (input: {
    repository: string
    prNumber: number
    threadKey: string
  }) => Promise<{ threadId: string | null }>
}

type StoreOptions = {
  url?: string
  createDb?: (url: string) => Db
}

const normalizeCursor = (cursor: string | null | undefined) =>
  cursor && cursor.trim().length > 0 ? cursor.trim() : null

const parseCursor = (cursor: string | null) => {
  if (!cursor) return null
  const [updatedAt, prNumberRaw] = cursor.split('|')
  const prNumber = Number.parseInt(prNumberRaw ?? '', 10)
  if (!updatedAt || !Number.isFinite(prNumber)) return null
  return { updatedAt, prNumber }
}

const buildCursor = (updatedAt: string | null, prNumber: number) => {
  if (!updatedAt) return null
  return `${updatedAt}|${prNumber}`
}

const decodeCheckSummary = (value: unknown): GithubCheckSummary | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const runs = Array.isArray(record.runs) ? (record.runs as GithubCheckRun[]) : []
  const status = typeof record.status === 'string' ? record.status : null
  const detailsUrl = typeof record.detailsUrl === 'string' ? record.detailsUrl : null
  const totalCount = Number(record.totalCount ?? runs.length)
  const successCount = Number(record.successCount ?? 0)
  const failureCount = Number(record.failureCount ?? 0)
  const pendingCount = Number(record.pendingCount ?? 0)
  return {
    status,
    detailsUrl,
    totalCount: Number.isFinite(totalCount) ? totalCount : runs.length,
    successCount: Number.isFinite(successCount) ? successCount : 0,
    failureCount: Number.isFinite(failureCount) ? failureCount : 0,
    pendingCount: Number.isFinite(pendingCount) ? pendingCount : 0,
    runs,
  }
}

const summarizeChecks = (runs: GithubCheckRun[]): GithubCheckSummary => {
  let successCount = 0
  let failureCount = 0
  let pendingCount = 0
  let status: string | null = null
  for (const run of runs) {
    const conclusion = (run.conclusion ?? '').toLowerCase()
    const runStatus = (run.status ?? '').toLowerCase()
    if (runStatus && runStatus !== 'completed') {
      pendingCount += 1
      continue
    }
    if (['success', 'neutral', 'skipped'].includes(conclusion)) {
      successCount += 1
      continue
    }
    if (conclusion) {
      failureCount += 1
      continue
    }
    pendingCount += 1
  }
  if (failureCount > 0) status = 'failure'
  else if (pendingCount > 0) status = 'pending'
  else if (successCount > 0) status = 'success'

  return {
    status,
    detailsUrl: runs.find((run) => run.url)?.url ?? null,
    totalCount: runs.length,
    successCount,
    failureCount,
    pendingCount,
    runs,
  }
}

const mergeRuns = (existing: GithubCheckRun[], incoming: GithubCheckRun) => {
  const map = new Map(existing.map((run) => [run.id, run]))
  map.set(incoming.id, { ...map.get(incoming.id), ...incoming })
  return Array.from(map.values())
}

export const createGithubReviewStore = (options: StoreOptions = {}): GithubReviewStore => {
  const url = options.url ?? process.env.DATABASE_URL ?? ''
  const createDb = options.createDb ?? createKyselyDb
  const db = url ? createDb(url) : getDb()
  if (!db) {
    throw new Error('DATABASE_URL is required')
  }

  const ready = ensureMigrations(db)

  const close = async () => {
    await db.destroy()
  }

  const recordEvent: GithubReviewStore['recordEvent'] = async (input) => {
    await ready
    const result = await db
      .insertInto('jangar_github.events')
      .values({
        delivery_id: input.deliveryId,
        event_type: input.eventType,
        action: input.action,
        repository: input.repository,
        pr_number: input.prNumber,
        commit_sha: input.commitSha,
        sender_login: input.senderLogin,
        payload: input.payload,
        received_at: input.receivedAt,
      })
      .onConflict((oc) => oc.columns(['delivery_id']).doNothing())
      .returning(['id'])
      .executeTakeFirst()
    return { inserted: Boolean(result?.id) }
  }

  const upsertPrState: GithubReviewStore['upsertPrState'] = async (input) => {
    await ready
    await db
      .insertInto('jangar_github.pr_state')
      .values({
        repository: input.repository,
        pr_number: input.number,
        commit_sha: input.headSha ?? input.baseSha ?? null,
        received_at: input.receivedAt,
        title: input.title,
        body: input.body,
        state: input.state,
        merged: input.merged,
        merged_at: input.mergedAt,
        draft: input.draft,
        author_login: input.authorLogin,
        author_avatar_url: input.authorAvatarUrl,
        html_url: input.htmlUrl,
        head_ref: input.headRef,
        head_sha: input.headSha,
        base_ref: input.baseRef,
        base_sha: input.baseSha,
        mergeable: input.mergeable,
        mergeable_state: input.mergeableState,
        labels: input.labels,
        additions: input.additions,
        deletions: input.deletions,
        changed_files: input.changedFiles,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
      })
      .onConflict((oc) =>
        oc.columns(['repository', 'pr_number']).doUpdateSet({
          commit_sha: input.headSha ?? input.baseSha ?? null,
          received_at: input.receivedAt,
          title: input.title,
          body: input.body,
          state: input.state,
          merged: input.merged,
          merged_at: input.mergedAt,
          draft: input.draft,
          author_login: input.authorLogin,
          author_avatar_url: input.authorAvatarUrl,
          html_url: input.htmlUrl,
          head_ref: input.headRef,
          head_sha: input.headSha,
          base_ref: input.baseRef,
          base_sha: input.baseSha,
          mergeable: input.mergeable,
          mergeable_state: input.mergeableState,
          labels: input.labels,
          additions: input.additions,
          deletions: input.deletions,
          changed_files: input.changedFiles,
          updated_at: input.updatedAt,
        }),
      )
      .execute()
  }

  const upsertReviewState: GithubReviewStore['upsertReviewState'] = async (input) => {
    await ready
    await db
      .insertInto('jangar_github.review_state')
      .values({
        repository: input.repository,
        pr_number: input.prNumber,
        commit_sha: input.commitSha,
        received_at: input.receivedAt,
        review_decision: input.decision,
        requested_changes: input.requestedChanges,
        unresolved_threads_count: input.unresolvedThreadsCount,
        summary: {
          decision: input.decision,
          requestedChanges: input.requestedChanges,
          unresolvedThreadsCount: input.unresolvedThreadsCount,
          latestReviewedAt: input.latestReviewedAt,
        },
        latest_reviewed_at: input.latestReviewedAt,
        updated_at: input.receivedAt,
      })
      .onConflict((oc) =>
        oc.columns(['repository', 'pr_number']).doUpdateSet({
          commit_sha: input.commitSha,
          received_at: input.receivedAt,
          review_decision: input.decision,
          requested_changes: input.requestedChanges,
          unresolved_threads_count: input.unresolvedThreadsCount,
          summary: {
            decision: input.decision,
            requestedChanges: input.requestedChanges,
            unresolvedThreadsCount: input.unresolvedThreadsCount,
            latestReviewedAt: input.latestReviewedAt,
          },
          latest_reviewed_at: input.latestReviewedAt,
          updated_at: input.receivedAt,
        }),
      )
      .execute()
  }

  const upsertCheckState: GithubReviewStore['upsertCheckState'] = async (input) => {
    await ready
    const existing = await db
      .selectFrom('jangar_github.check_state')
      .select(['checks'])
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .where('commit_sha', '=', input.commitSha)
      .executeTakeFirst()

    const existingSummary = decodeCheckSummary(existing?.checks)
    const runs = mergeRuns(existingSummary?.runs ?? [], input.check)
    const summary = summarizeChecks(runs)

    await db
      .insertInto('jangar_github.check_state')
      .values({
        repository: input.repository,
        pr_number: input.prNumber,
        commit_sha: input.commitSha,
        received_at: input.receivedAt,
        status: summary.status,
        details_url: summary.detailsUrl,
        total_count: summary.totalCount,
        success_count: summary.successCount,
        failure_count: summary.failureCount,
        pending_count: summary.pendingCount,
        checks: summary,
        updated_at: input.receivedAt,
      })
      .onConflict((oc) =>
        oc.columns(['repository', 'pr_number', 'commit_sha']).doUpdateSet({
          received_at: input.receivedAt,
          status: summary.status,
          details_url: summary.detailsUrl,
          total_count: summary.totalCount,
          success_count: summary.successCount,
          failure_count: summary.failureCount,
          pending_count: summary.pendingCount,
          checks: summary,
          updated_at: input.receivedAt,
        }),
      )
      .execute()

    return summary
  }

  const upsertReviewThread: GithubReviewStore['upsertReviewThread'] = async (input) => {
    await ready
    await db
      .insertInto('jangar_github.review_threads')
      .values({
        repository: input.repository,
        pr_number: input.prNumber,
        commit_sha: input.commitSha,
        received_at: input.receivedAt,
        thread_key: input.threadKey,
        thread_id: input.threadId,
        is_resolved: input.isResolved,
        path: input.path,
        line: input.line,
        side: input.side,
        start_line: input.startLine,
        author_login: input.authorLogin,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
      })
      .onConflict((oc) =>
        oc.columns(['repository', 'pr_number', 'thread_key']).doUpdateSet({
          commit_sha: input.commitSha,
          received_at: input.receivedAt,
          thread_id: input.threadId ?? sql.ref('jangar_github.review_threads.thread_id'),
          is_resolved: input.isResolved,
          path: input.path,
          line: input.line,
          side: input.side,
          start_line: input.startLine,
          author_login: input.authorLogin,
          updated_at: input.updatedAt ?? input.receivedAt,
        }),
      )
      .execute()
  }

  const upsertReviewComment: GithubReviewStore['upsertReviewComment'] = async (input) => {
    await ready
    await db
      .insertInto('jangar_github.comments')
      .values({
        repository: input.repository,
        pr_number: input.prNumber,
        commit_sha: input.commitSha,
        received_at: input.receivedAt,
        comment_id: input.commentId,
        comment_type: 'review',
        thread_key: input.threadKey,
        author_login: input.authorLogin,
        body: input.body,
        path: input.path,
        line: input.line,
        side: input.side,
        start_line: input.startLine,
        diff_hunk: input.diffHunk,
        url: input.url,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
      })
      .onConflict((oc) =>
        oc.column('comment_id').doUpdateSet({
          body: input.body,
          updated_at: input.updatedAt ?? input.receivedAt,
        }),
      )
      .execute()
  }

  const upsertIssueComment: GithubReviewStore['upsertIssueComment'] = async (input) => {
    await ready
    await db
      .insertInto('jangar_github.comments')
      .values({
        repository: input.repository,
        pr_number: input.prNumber,
        commit_sha: input.commitSha,
        received_at: input.receivedAt,
        comment_id: input.commentId,
        comment_type: 'issue',
        thread_key: null,
        author_login: input.authorLogin,
        body: input.body,
        url: input.url,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
      })
      .onConflict((oc) =>
        oc.column('comment_id').doUpdateSet({
          body: input.body,
          updated_at: input.updatedAt ?? input.receivedAt,
        }),
      )
      .execute()
  }

  const upsertPrFiles: GithubReviewStore['upsertPrFiles'] = async (input) => {
    await ready
    if (input.files.length === 0) return
    const source = input.source ?? 'worktree'

    await db.transaction().execute(async (trx) => {
      for (const file of input.files) {
        await trx
          .insertInto('jangar_github.pr_files')
          .values({
            repository: input.repository,
            pr_number: input.prNumber,
            commit_sha: input.commitSha,
            received_at: input.receivedAt,
            source,
            path: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch,
            blob_url: file.blobUrl,
            raw_url: file.rawUrl,
            sha: file.sha,
            previous_filename: file.previousFilename,
          })
          .onConflict((oc) =>
            oc.columns(['repository', 'pr_number', 'commit_sha', 'path']).doUpdateSet({
              received_at: input.receivedAt,
              source,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              changes: file.changes,
              patch: file.patch,
              blob_url: file.blobUrl,
              raw_url: file.rawUrl,
              sha: file.sha,
              previous_filename: file.previousFilename,
            }),
          )
          .execute()
      }
    })
  }

  const replacePrFiles: GithubReviewStore['replacePrFiles'] = async (input) => {
    await ready
    await db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('jangar_github.pr_files')
        .where('repository', '=', input.repository)
        .where('pr_number', '=', input.prNumber)
        .where('commit_sha', '=', input.commitSha)
        .execute()

      if (input.files.length === 0) return

      for (const file of input.files) {
        await trx
          .insertInto('jangar_github.pr_files')
          .values({
            repository: input.repository,
            pr_number: input.prNumber,
            commit_sha: input.commitSha,
            received_at: input.receivedAt,
            source: input.source,
            path: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch,
            blob_url: file.blobUrl,
            raw_url: file.rawUrl,
            sha: file.sha,
            previous_filename: file.previousFilename,
          })
          .execute()
      }
    })
  }

  const upsertPrWorktree: GithubReviewStore['upsertPrWorktree'] = async (input) => {
    await ready
    await db
      .insertInto('jangar_github.pr_worktrees')
      .values({
        repository: input.repository,
        pr_number: input.prNumber,
        worktree_name: input.worktreeName,
        worktree_path: input.worktreePath,
        base_sha: input.baseSha,
        head_sha: input.headSha,
        last_refreshed_at: input.lastRefreshedAt,
      })
      .onConflict((oc) =>
        oc.columns(['repository', 'pr_number']).doUpdateSet({
          worktree_name: input.worktreeName,
          worktree_path: input.worktreePath,
          base_sha: input.baseSha,
          head_sha: input.headSha,
          last_refreshed_at: input.lastRefreshedAt,
        }),
      )
      .execute()
  }

  const getPrWorktree: GithubReviewStore['getPrWorktree'] = async (input) => {
    await ready
    const row = await db
      .selectFrom('jangar_github.pr_worktrees')
      .select([
        'repository',
        'pr_number',
        'worktree_name',
        'worktree_path',
        'base_sha',
        'head_sha',
        'last_refreshed_at',
      ])
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .executeTakeFirst()
    if (!row) return null
    return {
      repository: row.repository,
      prNumber: row.pr_number,
      worktreeName: row.worktree_name,
      worktreePath: row.worktree_path,
      baseSha: row.base_sha ?? null,
      headSha: row.head_sha ?? null,
      lastRefreshedAt: row.last_refreshed_at ? String(row.last_refreshed_at) : new Date().toISOString(),
    }
  }

  const getUnresolvedThreadCount: GithubReviewStore['getUnresolvedThreadCount'] = async (input) => {
    await ready
    const result = await db
      .selectFrom('jangar_github.review_threads')
      .select(sql<number>`COUNT(*)::int`.as('count'))
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .where('is_resolved', '=', false)
      .executeTakeFirst()
    return result?.count ?? 0
  }

  const updateUnresolvedThreadCount: GithubReviewStore['updateUnresolvedThreadCount'] = async (input) => {
    await ready
    await db
      .insertInto('jangar_github.review_state')
      .values({
        repository: input.repository,
        pr_number: input.prNumber,
        commit_sha: null,
        received_at: input.receivedAt,
        review_decision: null,
        requested_changes: null,
        unresolved_threads_count: input.count,
        summary: { unresolvedThreadsCount: input.count },
        latest_reviewed_at: null,
        updated_at: input.receivedAt,
      })
      .onConflict((oc) =>
        oc.columns(['repository', 'pr_number']).doUpdateSet({
          unresolved_threads_count: input.count,
          summary: sql`jsonb_set(COALESCE(jangar_github.review_state.summary, '{}'::jsonb), '{unresolvedThreadsCount}', to_jsonb(${input.count}), true)`,
          updated_at: input.receivedAt,
        }),
      )
      .execute()
  }

  const listPulls: GithubReviewStore['listPulls'] = async (input) => {
    await ready
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
    const cursor = parseCursor(normalizeCursor(input.cursor))
    const query = db
      .selectFrom('jangar_github.pr_state')
      .leftJoin('jangar_github.review_state', (join) =>
        join
          .onRef('jangar_github.review_state.repository', '=', 'jangar_github.pr_state.repository')
          .onRef('jangar_github.review_state.pr_number', '=', 'jangar_github.pr_state.pr_number'),
      )
      .leftJoin('jangar_github.check_state', (join) =>
        join
          .onRef('jangar_github.check_state.repository', '=', 'jangar_github.pr_state.repository')
          .onRef('jangar_github.check_state.pr_number', '=', 'jangar_github.pr_state.pr_number')
          .onRef('jangar_github.check_state.commit_sha', '=', 'jangar_github.pr_state.head_sha'),
      )
      .select([
        'jangar_github.pr_state.repository as repository',
        'jangar_github.pr_state.pr_number as pr_number',
        'jangar_github.pr_state.title as title',
        'jangar_github.pr_state.body as body',
        'jangar_github.pr_state.state as state',
        'jangar_github.pr_state.merged as merged',
        'jangar_github.pr_state.merged_at as merged_at',
        'jangar_github.pr_state.draft as draft',
        'jangar_github.pr_state.author_login as author_login',
        'jangar_github.pr_state.author_avatar_url as author_avatar_url',
        'jangar_github.pr_state.html_url as html_url',
        'jangar_github.pr_state.head_ref as head_ref',
        'jangar_github.pr_state.head_sha as head_sha',
        'jangar_github.pr_state.base_ref as base_ref',
        'jangar_github.pr_state.base_sha as base_sha',
        'jangar_github.pr_state.mergeable as mergeable',
        'jangar_github.pr_state.mergeable_state as mergeable_state',
        'jangar_github.pr_state.labels as labels',
        'jangar_github.pr_state.additions as additions',
        'jangar_github.pr_state.deletions as deletions',
        'jangar_github.pr_state.changed_files as changed_files',
        'jangar_github.pr_state.created_at as created_at',
        'jangar_github.pr_state.updated_at as updated_at',
        'jangar_github.pr_state.received_at as received_at',
        'jangar_github.review_state.review_decision as review_decision',
        'jangar_github.review_state.requested_changes as requested_changes',
        'jangar_github.review_state.unresolved_threads_count as unresolved_threads_count',
        'jangar_github.review_state.latest_reviewed_at as latest_reviewed_at',
        'jangar_github.check_state.status as check_status',
        'jangar_github.check_state.details_url as check_details_url',
        'jangar_github.check_state.total_count as check_total_count',
        'jangar_github.check_state.success_count as check_success_count',
        'jangar_github.check_state.failure_count as check_failure_count',
        'jangar_github.check_state.pending_count as check_pending_count',
        'jangar_github.check_state.checks as check_checks',
      ])

    if (input.repository) {
      query.where('jangar_github.pr_state.repository', '=', input.repository)
    } else if (input.repositories && input.repositories.length > 0) {
      query.where('jangar_github.pr_state.repository', 'in', input.repositories)
    }

    if (input.state) {
      if (input.state === 'merged') {
        query.where('jangar_github.pr_state.merged', '=', true)
      } else {
        query.where('jangar_github.pr_state.state', '=', input.state)
      }
    }

    if (input.author) {
      query.where('jangar_github.pr_state.author_login', '=', input.author)
    }

    if (input.label) {
      query.where(sql<boolean>`${sql.value(input.label)} = ANY(${sql.ref('jangar_github.pr_state.labels')})`)
    }

    if (input.reviewDecision) {
      query.where('jangar_github.review_state.review_decision', '=', input.reviewDecision)
    }

    if (input.ciStatus) {
      query.where('jangar_github.check_state.status', '=', input.ciStatus)
    }

    if (cursor) {
      query.where(
        sql<boolean>`(COALESCE(${sql.ref('jangar_github.pr_state.updated_at')}, ${sql.ref('jangar_github.pr_state.received_at')}) < ${cursor.updatedAt}
          OR (COALESCE(${sql.ref('jangar_github.pr_state.updated_at')}, ${sql.ref('jangar_github.pr_state.received_at')}) = ${cursor.updatedAt}
            AND ${sql.ref('jangar_github.pr_state.pr_number')} < ${cursor.prNumber}))`,
      )
    }

    query.orderBy(
      sql`COALESCE(${sql.ref('jangar_github.pr_state.updated_at')}, ${sql.ref('jangar_github.pr_state.received_at')})`,
      'desc',
    )
    query.orderBy('jangar_github.pr_state.pr_number', 'desc')
    query.limit(limit + 1)

    const rows = await query.execute()
    const items = rows.slice(0, limit).map((row) => {
      const reviewDecision = row.review_decision ?? null
      const unresolvedThreadsCount = Number(row.unresolved_threads_count ?? 0)
      const review: GithubReviewSummary | null = reviewDecision
        ? {
            decision: reviewDecision,
            requestedChanges: row.requested_changes ?? null,
            unresolvedThreadsCount: Number.isFinite(unresolvedThreadsCount) ? unresolvedThreadsCount : 0,
            latestReviewedAt: row.latest_reviewed_at ? String(row.latest_reviewed_at) : null,
          }
        : null

      const checkSummary =
        decodeCheckSummary(row.check_checks) ??
        (row.check_status || row.check_total_count !== null
          ? {
              status: row.check_status ?? null,
              detailsUrl: row.check_details_url ?? null,
              totalCount: Number(row.check_total_count ?? 0),
              successCount: Number(row.check_success_count ?? 0),
              failureCount: Number(row.check_failure_count ?? 0),
              pendingCount: Number(row.check_pending_count ?? 0),
              runs: [],
            }
          : null)

      return {
        repository: row.repository,
        number: Number(row.pr_number),
        title: row.title ?? null,
        body: row.body ?? null,
        state: row.state ?? null,
        merged: row.merged ?? null,
        mergedAt: row.merged_at ? String(row.merged_at) : null,
        draft: row.draft ?? null,
        authorLogin: row.author_login ?? null,
        authorAvatarUrl: row.author_avatar_url ?? null,
        htmlUrl: row.html_url ?? null,
        headRef: row.head_ref ?? null,
        headSha: row.head_sha ?? null,
        baseRef: row.base_ref ?? null,
        baseSha: row.base_sha ?? null,
        mergeable: row.mergeable ?? null,
        mergeableState: row.mergeable_state ?? null,
        labels: row.labels ?? [],
        additions: row.additions ?? null,
        deletions: row.deletions ?? null,
        changedFiles: row.changed_files ?? null,
        createdAt: row.created_at ? String(row.created_at) : null,
        updatedAt: row.updated_at ? String(row.updated_at) : null,
        receivedAt: String(row.received_at),
        review,
        checks: checkSummary,
      }
    })

    const nextRow = rows.length > limit ? rows[limit] : null
    const nextCursor = nextRow
      ? buildCursor(
          nextRow.updated_at ? String(nextRow.updated_at) : nextRow.received_at ? String(nextRow.received_at) : null,
          Number(nextRow.pr_number),
        )
      : null

    return { items, nextCursor }
  }

  const getPull: GithubReviewStore['getPull'] = async (input) => {
    await ready
    const row = await db
      .selectFrom('jangar_github.pr_state')
      .leftJoin('jangar_github.review_state', (join) =>
        join
          .onRef('jangar_github.review_state.repository', '=', 'jangar_github.pr_state.repository')
          .onRef('jangar_github.review_state.pr_number', '=', 'jangar_github.pr_state.pr_number'),
      )
      .leftJoin('jangar_github.check_state', (join) =>
        join
          .onRef('jangar_github.check_state.repository', '=', 'jangar_github.pr_state.repository')
          .onRef('jangar_github.check_state.pr_number', '=', 'jangar_github.pr_state.pr_number')
          .onRef('jangar_github.check_state.commit_sha', '=', 'jangar_github.pr_state.head_sha'),
      )
      .selectAll('jangar_github.pr_state')
      .select([
        'jangar_github.review_state.review_decision as review_decision',
        'jangar_github.review_state.requested_changes as requested_changes',
        'jangar_github.review_state.unresolved_threads_count as unresolved_threads_count',
        'jangar_github.review_state.latest_reviewed_at as latest_reviewed_at',
        'jangar_github.check_state.status as check_status',
        'jangar_github.check_state.details_url as check_details_url',
        'jangar_github.check_state.total_count as check_total_count',
        'jangar_github.check_state.success_count as check_success_count',
        'jangar_github.check_state.failure_count as check_failure_count',
        'jangar_github.check_state.pending_count as check_pending_count',
        'jangar_github.check_state.checks as check_checks',
      ])
      .where('jangar_github.pr_state.repository', '=', input.repository)
      .where('jangar_github.pr_state.pr_number', '=', input.prNumber)
      .executeTakeFirst()

    if (!row) {
      return { pull: null, review: null, checks: null, issueComments: [] }
    }

    const reviewDecision = row.review_decision ?? null
    const unresolvedThreadsCount = Number(row.unresolved_threads_count ?? 0)
    const review: GithubReviewSummary | null = reviewDecision
      ? {
          decision: reviewDecision,
          requestedChanges: row.requested_changes ?? null,
          unresolvedThreadsCount: Number.isFinite(unresolvedThreadsCount) ? unresolvedThreadsCount : 0,
          latestReviewedAt: row.latest_reviewed_at ? String(row.latest_reviewed_at) : null,
        }
      : null

    const checks =
      decodeCheckSummary(row.check_checks) ??
      (row.check_status || row.check_total_count !== null
        ? {
            status: row.check_status ?? null,
            detailsUrl: row.check_details_url ?? null,
            totalCount: Number(row.check_total_count ?? 0),
            successCount: Number(row.check_success_count ?? 0),
            failureCount: Number(row.check_failure_count ?? 0),
            pendingCount: Number(row.check_pending_count ?? 0),
            runs: [],
          }
        : null)

    const issueCommentsRows = await db
      .selectFrom('jangar_github.comments')
      .select(['comment_id', 'author_login', 'body', 'created_at', 'updated_at', 'url'])
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .where('comment_type', '=', 'issue')
      .orderBy('created_at', 'asc')
      .execute()

    const issueComments: GithubIssueComment[] = issueCommentsRows.map((comment) => ({
      commentId: comment.comment_id,
      authorLogin: comment.author_login ?? null,
      body: comment.body ?? null,
      createdAt: comment.created_at ? String(comment.created_at) : null,
      updatedAt: comment.updated_at ? String(comment.updated_at) : null,
      url: comment.url ?? null,
    }))

    const pull: GithubPullState = {
      repository: row.repository,
      number: row.pr_number,
      title: row.title ?? null,
      body: row.body ?? null,
      state: row.state ?? null,
      merged: row.merged ?? null,
      mergedAt: row.merged_at ? String(row.merged_at) : null,
      draft: row.draft ?? null,
      authorLogin: row.author_login ?? null,
      authorAvatarUrl: row.author_avatar_url ?? null,
      htmlUrl: row.html_url ?? null,
      headRef: row.head_ref ?? null,
      headSha: row.head_sha ?? null,
      baseRef: row.base_ref ?? null,
      baseSha: row.base_sha ?? null,
      mergeable: row.mergeable ?? null,
      mergeableState: row.mergeable_state ?? null,
      labels: row.labels ?? [],
      additions: row.additions ?? null,
      deletions: row.deletions ?? null,
      changedFiles: row.changed_files ?? null,
      createdAt: row.created_at ? String(row.created_at) : null,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
      receivedAt: String(row.received_at),
    }

    return { pull, review, checks, issueComments }
  }

  const listFiles: GithubReviewStore['listFiles'] = async (input) => {
    await ready
    if (!input.commitSha) return []
    let query = db
      .selectFrom('jangar_github.pr_files')
      .select([
        'path',
        'source',
        'status',
        'additions',
        'deletions',
        'changes',
        'patch',
        'blob_url',
        'raw_url',
        'sha',
        'previous_filename',
      ])
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .where('commit_sha', '=', input.commitSha)

    if (input.source) {
      query = query.where('source', '=', input.source)
    }

    const rows = await query.orderBy('path', 'asc').execute()

    return rows.map((row) => ({
      path: row.path,
      source: row.source ?? null,
      status: row.status ?? null,
      additions: row.additions ?? null,
      deletions: row.deletions ?? null,
      changes: row.changes ?? null,
      patch: row.patch ?? null,
      blobUrl: row.blob_url ?? null,
      rawUrl: row.raw_url ?? null,
      sha: row.sha ?? null,
      previousFilename: row.previous_filename ?? null,
    }))
  }

  const listCheckStates: GithubReviewStore['listCheckStates'] = async (input) => {
    await ready
    const rows = await db
      .selectFrom('jangar_github.check_state')
      .select([
        'commit_sha',
        'status',
        'details_url',
        'total_count',
        'success_count',
        'failure_count',
        'pending_count',
        'checks',
        'updated_at',
      ])
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .orderBy('updated_at', 'desc')
      .execute()

    return rows.map((row) => {
      const decoded =
        decodeCheckSummary(row.checks) ??
        (row.status || row.total_count !== null
          ? {
              status: row.status ?? null,
              detailsUrl: row.details_url ?? null,
              totalCount: Number(row.total_count ?? 0),
              successCount: Number(row.success_count ?? 0),
              failureCount: Number(row.failure_count ?? 0),
              pendingCount: Number(row.pending_count ?? 0),
              runs: [],
            }
          : {
              status: null,
              detailsUrl: null,
              totalCount: 0,
              successCount: 0,
              failureCount: 0,
              pendingCount: 0,
              runs: [],
            })
      return {
        commitSha: row.commit_sha,
        status: decoded.status,
        detailsUrl: decoded.detailsUrl,
        totalCount: decoded.totalCount,
        successCount: decoded.successCount,
        failureCount: decoded.failureCount,
        pendingCount: decoded.pendingCount,
        runs: decoded.runs,
        updatedAt: row.updated_at ? String(row.updated_at) : null,
      }
    })
  }

  const listThreads: GithubReviewStore['listThreads'] = async (input) => {
    await ready
    const threads = await db
      .selectFrom('jangar_github.review_threads')
      .selectAll()
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .orderBy('created_at', 'asc')
      .execute()

    if (threads.length === 0) return []

    const threadKeys = threads.map((thread) => thread.thread_key)
    const comments = await db
      .selectFrom('jangar_github.comments')
      .selectAll()
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .where('comment_type', '=', 'review')
      .where('thread_key', 'in', threadKeys)
      .orderBy('created_at', 'asc')
      .execute()

    const commentMap = new Map<string, GithubReviewComment[]>()
    for (const comment of comments) {
      const list = commentMap.get(comment.thread_key ?? '') ?? []
      list.push({
        commentId: comment.comment_id,
        authorLogin: comment.author_login ?? null,
        body: comment.body ?? null,
        createdAt: comment.created_at ? String(comment.created_at) : null,
        updatedAt: comment.updated_at ? String(comment.updated_at) : null,
        path: comment.path ?? null,
        line: comment.line ?? null,
        side: comment.side ?? null,
        startLine: comment.start_line ?? null,
        diffHunk: comment.diff_hunk ?? null,
        url: comment.url ?? null,
      })
      if (comment.thread_key) {
        commentMap.set(comment.thread_key, list)
      }
    }

    return threads.map((thread) => ({
      threadKey: thread.thread_key,
      threadId: thread.thread_id ?? null,
      isResolved: Boolean(thread.is_resolved),
      path: thread.path ?? null,
      line: thread.line ?? null,
      side: thread.side ?? null,
      startLine: thread.start_line ?? null,
      authorLogin: thread.author_login ?? null,
      createdAt: thread.created_at ? String(thread.created_at) : null,
      updatedAt: thread.updated_at ? String(thread.updated_at) : null,
      comments: commentMap.get(thread.thread_key) ?? [],
    }))
  }

  const updateThreadResolution: GithubReviewStore['updateThreadResolution'] = async (input) => {
    await ready
    await db
      .updateTable('jangar_github.review_threads')
      .set({
        is_resolved: input.resolved,
        thread_id: input.threadId ?? sql.ref('jangar_github.review_threads.thread_id'),
        resolved_at: input.resolved ? input.receivedAt : null,
        updated_at: input.receivedAt,
      })
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .where('thread_key', '=', input.threadKey)
      .execute()
  }

  const updateMergeState: GithubReviewStore['updateMergeState'] = async (input) => {
    await ready
    await db
      .updateTable('jangar_github.pr_state')
      .set({
        merged: input.merged,
        mergeable_state: input.mergeableState ?? sql.ref('jangar_github.pr_state.mergeable_state'),
        received_at: input.receivedAt,
      })
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .execute()
  }

  const updateReviewDecision: GithubReviewStore['updateReviewDecision'] = async (input) => {
    await ready
    await db
      .updateTable('jangar_github.review_state')
      .set({
        review_decision: input.decision,
        requested_changes: input.requestedChanges,
        latest_reviewed_at: input.receivedAt,
        updated_at: input.receivedAt,
      })
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .execute()
  }

  const insertWriteAudit: GithubReviewStore['insertWriteAudit'] = async (input) => {
    await ready
    await db
      .insertInto('jangar_github.write_actions')
      .values({
        repository: input.repository,
        pr_number: input.prNumber,
        commit_sha: input.commitSha,
        received_at: input.receivedAt,
        action: input.action,
        actor: input.actor,
        request_id: input.requestId,
        payload: input.payload,
        response: input.response ?? null,
        success: input.success,
        error: input.error ?? null,
      })
      .execute()
  }

  const resolveThreadKey: GithubReviewStore['resolveThreadKey'] = async (input) => {
    await ready
    const row = await db
      .selectFrom('jangar_github.review_threads')
      .select(['thread_id'])
      .where('repository', '=', input.repository)
      .where('pr_number', '=', input.prNumber)
      .where('thread_key', '=', input.threadKey)
      .executeTakeFirst()
    return { threadId: row?.thread_id ?? null }
  }

  return {
    ready,
    close,
    recordEvent,
    upsertPrState,
    upsertReviewState,
    upsertCheckState,
    upsertReviewThread,
    upsertReviewComment,
    upsertIssueComment,
    upsertPrFiles,
    replacePrFiles,
    upsertPrWorktree,
    getPrWorktree,
    getUnresolvedThreadCount,
    updateUnresolvedThreadCount,
    listPulls,
    getPull,
    listFiles,
    listCheckStates,
    listThreads,
    updateThreadResolution,
    updateMergeState,
    updateReviewDecision,
    insertWriteAudit,
    resolveThreadKey,
  }
}
