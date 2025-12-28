import { sql } from 'kysely'

import { createKyselyDb, type Db } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

export type CodexRunRecord = {
  id: string
  repository: string
  issueNumber: number
  branch: string
  attempt: number
  workflowName: string
  workflowUid: string | null
  workflowNamespace: string | null
  stage: string | null
  status: string
  phase: string | null
  prompt: string | null
  nextPrompt: string | null
  commitSha: string | null
  prNumber: number | null
  prUrl: string | null
  ciStatus: string | null
  ciUrl: string | null
  reviewStatus: string | null
  reviewSummary: Record<string, unknown>
  notifyPayload: Record<string, unknown> | null
  runCompletePayload: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type CodexArtifactRecord = {
  id: string
  runId: string
  name: string
  key: string
  bucket: string | null
  url: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type CodexEvaluationRecord = {
  id: string
  runId: string
  decision: string
  confidence: number | null
  reasons: Record<string, unknown>
  missingItems: Record<string, unknown>
  suggestedFixes: Record<string, unknown>
  nextPrompt: string | null
  promptTuning: Record<string, unknown>
  systemSuggestions: Record<string, unknown>
  createdAt: string
}

export type CodexPromptTuningRecord = {
  id: string
  runId: string
  prUrl: string
  status: string
  metadata: Record<string, unknown>
  createdAt: string
}

export type UpsertRunCompleteInput = {
  repository: string
  issueNumber: number
  branch: string
  workflowName: string
  workflowUid: string | null
  workflowNamespace: string | null
  stage: string | null
  status: string
  phase: string | null
  prompt: string | null
  runCompletePayload: Record<string, unknown>
  startedAt: string | null
  finishedAt: string | null
}

export type AttachNotifyInput = {
  workflowName: string
  workflowNamespace?: string | null
  notifyPayload: Record<string, unknown>
  repository?: string
  issueNumber?: number
  branch?: string
  prompt?: string | null
}

export type UpdateCiInput = {
  runId: string
  status: string
  url?: string | null
  commitSha?: string | null
}

export type UpdateReviewInput = {
  runId: string
  status: string
  summary: Record<string, unknown>
}

export type UpdateDecisionInput = {
  runId: string
  decision: string
  confidence?: number | null
  reasons?: Record<string, unknown>
  missingItems?: Record<string, unknown>
  suggestedFixes?: Record<string, unknown>
  nextPrompt?: string | null
  promptTuning?: Record<string, unknown>
  systemSuggestions?: Record<string, unknown>
}

export type UpsertArtifactsInput = {
  runId: string
  artifacts: Array<{
    name: string
    key: string
    bucket?: string | null
    url?: string | null
    metadata?: Record<string, unknown>
  }>
}

export type CodexJudgeStore = {
  upsertRunComplete: (input: UpsertRunCompleteInput) => Promise<CodexRunRecord>
  attachNotify: (input: AttachNotifyInput) => Promise<CodexRunRecord | null>
  updateCiStatus: (input: UpdateCiInput) => Promise<CodexRunRecord | null>
  updateReviewStatus: (input: UpdateReviewInput) => Promise<CodexRunRecord | null>
  updateDecision: (input: UpdateDecisionInput) => Promise<CodexEvaluationRecord>
  updateRunStatus: (runId: string, status: string) => Promise<CodexRunRecord | null>
  updateRunPrompt: (runId: string, prompt: string | null, nextPrompt?: string | null) => Promise<CodexRunRecord | null>
  updateRunPrInfo: (
    runId: string,
    prNumber: number,
    prUrl: string,
    commitSha?: string | null,
  ) => Promise<CodexRunRecord | null>
  upsertArtifacts: (input: UpsertArtifactsInput) => Promise<CodexArtifactRecord[]>
  getRunByWorkflow: (workflowName: string, namespace?: string | null) => Promise<CodexRunRecord | null>
  getRunById: (runId: string) => Promise<CodexRunRecord | null>
  listRunsByIssue: (repository: string, issueNumber: number, branch: string) => Promise<CodexRunRecord[]>
  createPromptTuning: (
    runId: string,
    prUrl: string,
    status: string,
    metadata?: Record<string, unknown>,
  ) => Promise<CodexPromptTuningRecord>
  close: () => Promise<void>
}

const ensureSchema = async (db: Db) => {
  await ensureMigrations(db)
}

const rowToRun = (row: Record<string, unknown>): CodexRunRecord => {
  return {
    id: String(row.id),
    repository: String(row.repository),
    issueNumber: Number(row.issue_number),
    branch: String(row.branch),
    attempt: Number(row.attempt),
    workflowName: String(row.workflow_name),
    workflowUid: row.workflow_uid ? String(row.workflow_uid) : null,
    workflowNamespace: row.workflow_namespace ? String(row.workflow_namespace) : null,
    stage: row.stage ? String(row.stage) : null,
    status: String(row.status),
    phase: row.phase ? String(row.phase) : null,
    prompt: row.prompt ? String(row.prompt) : null,
    nextPrompt: row.next_prompt ? String(row.next_prompt) : null,
    commitSha: row.commit_sha ? String(row.commit_sha) : null,
    prNumber: row.pr_number != null ? Number(row.pr_number) : null,
    prUrl: row.pr_url ? String(row.pr_url) : null,
    ciStatus: row.ci_status ? String(row.ci_status) : null,
    ciUrl: row.ci_url ? String(row.ci_url) : null,
    reviewStatus: row.review_status ? String(row.review_status) : null,
    reviewSummary: (row.review_summary as Record<string, unknown>) ?? {},
    notifyPayload: (row.notify_payload as Record<string, unknown>) ?? null,
    runCompletePayload: (row.run_complete_payload as Record<string, unknown>) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  }
}

const rowToArtifact = (row: Record<string, unknown>): CodexArtifactRecord => ({
  id: String(row.id),
  runId: String(row.run_id),
  name: String(row.name),
  key: String(row.key),
  bucket: row.bucket ? String(row.bucket) : null,
  url: row.url ? String(row.url) : null,
  metadata: (row.metadata as Record<string, unknown>) ?? {},
  createdAt: String(row.created_at),
})

const rowToEvaluation = (row: Record<string, unknown>): CodexEvaluationRecord => ({
  id: String(row.id),
  runId: String(row.run_id),
  decision: String(row.decision),
  confidence: row.confidence == null ? null : Number(row.confidence),
  reasons: (row.reasons as Record<string, unknown>) ?? {},
  missingItems: (row.missing_items as Record<string, unknown>) ?? {},
  suggestedFixes: (row.suggested_fixes as Record<string, unknown>) ?? {},
  nextPrompt: row.next_prompt ? String(row.next_prompt) : null,
  promptTuning: (row.prompt_tuning as Record<string, unknown>) ?? {},
  systemSuggestions: (row.system_suggestions as Record<string, unknown>) ?? {},
  createdAt: String(row.created_at),
})

const rowToPromptTuning = (row: Record<string, unknown>): CodexPromptTuningRecord => ({
  id: String(row.id),
  runId: String(row.run_id),
  prUrl: String(row.pr_url),
  status: String(row.status),
  metadata: (row.metadata as Record<string, unknown>) ?? {},
  createdAt: String(row.created_at),
})

export const createCodexJudgeStore = (
  options: { url?: string; createDb?: (url: string) => Db } = {},
): CodexJudgeStore => {
  const url = options.url ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required for Codex judge storage')
  }

  const db = (options.createDb ?? createKyselyDb)(url)
  let schemaReady: Promise<void> | null = null

  const ensureReady = async () => {
    if (!schemaReady) {
      schemaReady = ensureSchema(db)
    }
    await schemaReady
  }

  const getRunByWorkflow = async (workflowName: string, namespace?: string | null) => {
    await ensureReady()
    const row = await db
      .selectFrom('codex_judge.runs')
      .selectAll()
      .where('workflow_name', '=', workflowName)
      .where('workflow_namespace', '=', namespace ?? null)
      .executeTakeFirst()
    return row ? rowToRun(row as Record<string, unknown>) : null
  }

  const getRunById = async (runId: string) => {
    await ensureReady()
    const row = await db.selectFrom('codex_judge.runs').selectAll().where('id', '=', runId).executeTakeFirst()
    return row ? rowToRun(row as Record<string, unknown>) : null
  }

  const listRunsByIssue = async (repository: string, issueNumber: number, branch: string) => {
    await ensureReady()
    const rows = await db
      .selectFrom('codex_judge.runs')
      .selectAll()
      .where('repository', '=', repository)
      .where('issue_number', '=', issueNumber)
      .where('branch', '=', branch)
      .orderBy('created_at desc')
      .execute()
    return rows.map((row) => rowToRun(row as Record<string, unknown>))
  }

  const upsertRunComplete = async (input: UpsertRunCompleteInput) => {
    await ensureReady()
    const existingByUid = input.workflowUid
      ? await db
          .selectFrom('codex_judge.runs')
          .selectAll()
          .where('workflow_uid', '=', input.workflowUid)
          .executeTakeFirst()
      : null
    const existingByName = existingByUid
      ? null
      : await db
          .selectFrom('codex_judge.runs')
          .selectAll()
          .where('workflow_name', '=', input.workflowName)
          .where('workflow_namespace', '=', input.workflowNamespace ?? null)
          .executeTakeFirst()

    const existing = existingByUid ?? existingByName

    if (existing) {
      const updated = await db
        .updateTable('codex_judge.runs')
        .set({
          repository: input.repository,
          issue_number: input.issueNumber,
          branch: input.branch,
          workflow_name: input.workflowName,
          workflow_namespace: input.workflowNamespace ?? null,
          stage: input.stage,
          status: 'run_complete',
          phase: input.phase,
          prompt: input.prompt,
          run_complete_payload: input.runCompletePayload,
          started_at: input.startedAt ? new Date(input.startedAt) : null,
          finished_at: input.finishedAt ? new Date(input.finishedAt) : null,
          updated_at: sql`now()`,
        })
        .where('id', '=', String(existing.id))
        .returningAll()
        .executeTakeFirstOrThrow()
      return rowToRun(updated as Record<string, unknown>)
    }

    const priorRuns = await db
      .selectFrom('codex_judge.runs')
      .select(['attempt'])
      .where('repository', '=', input.repository)
      .where('issue_number', '=', input.issueNumber)
      .where('branch', '=', input.branch)
      .execute()
    const attempt = priorRuns.reduce((max, row) => Math.max(max, Number(row.attempt ?? 0)), 0) + 1

    const inserted = await db
      .insertInto('codex_judge.runs')
      .values({
        repository: input.repository,
        issue_number: input.issueNumber,
        branch: input.branch,
        attempt,
        workflow_name: input.workflowName,
        workflow_uid: input.workflowUid,
        workflow_namespace: input.workflowNamespace,
        stage: input.stage,
        status: 'run_complete',
        phase: input.phase,
        prompt: input.prompt,
        run_complete_payload: input.runCompletePayload,
        started_at: input.startedAt ? new Date(input.startedAt) : null,
        finished_at: input.finishedAt ? new Date(input.finishedAt) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return rowToRun(inserted as Record<string, unknown>)
  }

  const attachNotify = async (input: AttachNotifyInput) => {
    await ensureReady()
    const row = await db
      .selectFrom('codex_judge.runs')
      .selectAll()
      .where('workflow_name', '=', input.workflowName)
      .where('workflow_namespace', '=', input.workflowNamespace ?? null)
      .executeTakeFirst()
    if (!row) {
      if (!input.repository || !input.issueNumber || !input.branch) {
        return null
      }

      const priorRuns = await db
        .selectFrom('codex_judge.runs')
        .select(['attempt'])
        .where('repository', '=', input.repository)
        .where('issue_number', '=', input.issueNumber)
        .where('branch', '=', input.branch)
        .execute()
      const attempt = priorRuns.reduce((max, row) => Math.max(max, Number(row.attempt ?? 0)), 0) + 1

      const inserted = await db
        .insertInto('codex_judge.runs')
        .values({
          repository: input.repository,
          issue_number: input.issueNumber,
          branch: input.branch,
          attempt,
          workflow_name: input.workflowName,
          workflow_namespace: input.workflowNamespace ?? null,
          status: 'notified',
          prompt: input.prompt ?? null,
          notify_payload: input.notifyPayload,
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      return rowToRun(inserted as Record<string, unknown>)
    }

    const updated = await db
      .updateTable('codex_judge.runs')
      .set({
        repository: input.repository && input.repository.length > 0 ? input.repository : row.repository,
        issue_number: input.issueNumber ?? row.issue_number,
        branch: input.branch && input.branch.length > 0 ? input.branch : row.branch,
        prompt: input.prompt ?? row.prompt,
        notify_payload: input.notifyPayload,
        updated_at: sql`now()`,
      })
      .where('id', '=', String(row.id))
      .returningAll()
      .executeTakeFirstOrThrow()

    return rowToRun(updated as Record<string, unknown>)
  }

  const updateCiStatus = async (input: UpdateCiInput) => {
    await ensureReady()
    const updated = await db
      .updateTable('codex_judge.runs')
      .set({
        ci_status: input.status,
        ci_url: input.url ?? null,
        commit_sha: input.commitSha ?? sql`coalesce(commit_sha, commit_sha)`,
        updated_at: sql`now()`,
      })
      .where('id', '=', input.runId)
      .returningAll()
      .executeTakeFirst()

    return updated ? rowToRun(updated as Record<string, unknown>) : null
  }

  const updateReviewStatus = async (input: UpdateReviewInput) => {
    await ensureReady()
    const updated = await db
      .updateTable('codex_judge.runs')
      .set({
        review_status: input.status,
        review_summary: input.summary,
        updated_at: sql`now()`,
      })
      .where('id', '=', input.runId)
      .returningAll()
      .executeTakeFirst()

    return updated ? rowToRun(updated as Record<string, unknown>) : null
  }

  const updateDecision = async (input: UpdateDecisionInput) => {
    await ensureReady()
    const inserted = await db
      .insertInto('codex_judge.evaluations')
      .values({
        run_id: input.runId,
        decision: input.decision,
        confidence: input.confidence ?? null,
        reasons: input.reasons ?? {},
        missing_items: input.missingItems ?? {},
        suggested_fixes: input.suggestedFixes ?? {},
        next_prompt: input.nextPrompt ?? null,
        prompt_tuning: input.promptTuning ?? {},
        system_suggestions: input.systemSuggestions ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    await db
      .updateTable('codex_judge.runs')
      .set({
        status: input.decision === 'pass' ? 'completed' : input.decision,
        next_prompt: input.nextPrompt ?? null,
        updated_at: sql`now()`,
      })
      .where('id', '=', input.runId)
      .execute()

    return rowToEvaluation(inserted as Record<string, unknown>)
  }

  const updateRunStatus = async (runId: string, status: string) => {
    await ensureReady()
    const updated = await db
      .updateTable('codex_judge.runs')
      .set({ status, updated_at: sql`now()` })
      .where('id', '=', runId)
      .returningAll()
      .executeTakeFirst()
    return updated ? rowToRun(updated as Record<string, unknown>) : null
  }

  const updateRunPrompt = async (runId: string, prompt: string | null, nextPrompt?: string | null) => {
    await ensureReady()
    const updated = await db
      .updateTable('codex_judge.runs')
      .set({
        prompt,
        next_prompt: nextPrompt ?? null,
        updated_at: sql`now()`,
      })
      .where('id', '=', runId)
      .returningAll()
      .executeTakeFirst()
    return updated ? rowToRun(updated as Record<string, unknown>) : null
  }

  const updateRunPrInfo = async (runId: string, prNumber: number, prUrl: string, commitSha?: string | null) => {
    await ensureReady()
    const updated = await db
      .updateTable('codex_judge.runs')
      .set({
        pr_number: prNumber,
        pr_url: prUrl,
        commit_sha: commitSha ?? sql`coalesce(commit_sha, commit_sha)`,
        updated_at: sql`now()`,
      })
      .where('id', '=', runId)
      .returningAll()
      .executeTakeFirst()
    return updated ? rowToRun(updated as Record<string, unknown>) : null
  }

  const upsertArtifacts = async (input: UpsertArtifactsInput) => {
    await ensureReady()
    if (input.artifacts.length === 0) return []

    const rows: CodexArtifactRecord[] = []
    for (const artifact of input.artifacts) {
      const existing = await db
        .selectFrom('codex_judge.artifacts')
        .selectAll()
        .where('run_id', '=', input.runId)
        .where('name', '=', artifact.name)
        .executeTakeFirst()

      const payload = {
        run_id: input.runId,
        name: artifact.name,
        key: artifact.key,
        bucket: artifact.bucket ?? null,
        url: artifact.url ?? null,
        metadata: artifact.metadata ?? {},
      }

      if (existing) {
        const updated = await db
          .updateTable('codex_judge.artifacts')
          .set({
            key: payload.key,
            bucket: payload.bucket,
            url: payload.url,
            metadata: payload.metadata,
          })
          .where('id', '=', String(existing.id))
          .returningAll()
          .executeTakeFirstOrThrow()
        rows.push(rowToArtifact(updated as Record<string, unknown>))
      } else {
        const inserted = await db
          .insertInto('codex_judge.artifacts')
          .values(payload)
          .returningAll()
          .executeTakeFirstOrThrow()
        rows.push(rowToArtifact(inserted as Record<string, unknown>))
      }
    }

    return rows
  }

  const createPromptTuning = async (
    runId: string,
    prUrl: string,
    status: string,
    metadata: Record<string, unknown> = {},
  ) => {
    await ensureReady()
    const inserted = await db
      .insertInto('codex_judge.prompt_tuning')
      .values({
        run_id: runId,
        pr_url: prUrl,
        status,
        metadata,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return rowToPromptTuning(inserted as Record<string, unknown>)
  }

  const close = async () => {
    await db.destroy()
  }

  return {
    upsertRunComplete,
    attachNotify,
    updateCiStatus,
    updateReviewStatus,
    updateDecision,
    updateRunStatus,
    updateRunPrompt,
    updateRunPrInfo,
    upsertArtifacts,
    getRunByWorkflow,
    getRunById,
    listRunsByIssue,
    createPromptTuning,
    close,
  }
}
