import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely'
import { describe, expect, it } from 'vitest'

import { createCodexJudgeStore } from '../codex-judge-store'
import type { Database } from '../db'

type SqlCall = { sql: string; params: readonly unknown[] }

type FakeDbOptions = {
  runs?: Array<Record<string, unknown>>
  artifacts?: Array<Record<string, unknown>>
  evaluations?: Array<Record<string, unknown>>
}

const makeFakeDb = (options: FakeDbOptions = {}) => {
  const calls: SqlCall[] = []

  class TestConnection implements DatabaseConnection {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      const params = (compiledQuery.parameters ?? []) as readonly unknown[]
      calls.push({ sql: compiledQuery.sql, params })

      const normalized = compiledQuery.sql.toLowerCase()

      if (normalized.includes('select extname from pg_extension')) {
        return { rows: [{ extname: 'vector' }, { extname: 'pgcrypto' }] as R[] }
      }

      if (normalized.includes('from "codex_judge"."runs"')) {
        return { rows: (options.runs ?? []) as R[] }
      }

      if (normalized.includes('from "codex_judge"."artifacts"')) {
        return { rows: (options.artifacts ?? []) as R[] }
      }

      if (normalized.includes('from "codex_judge"."evaluations"')) {
        return { rows: (options.evaluations ?? []) as R[] }
      }

      return { rows: [] as R[] }
    }

    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      yield* []
    }
  }

  class TestDriver implements Driver {
    async init() {}

    async acquireConnection(): Promise<DatabaseConnection> {
      return new TestConnection()
    }

    async beginTransaction() {}

    async commitTransaction() {}

    async rollbackTransaction() {}

    async releaseConnection() {}

    async destroy() {}
  }

  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new TestDriver(),
      createIntrospector: (dbInstance) => new PostgresIntrospector(dbInstance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })

  return { db, calls }
}

describe('codex judge store run history', () => {
  it('returns runs with artifacts and latest evaluations', async () => {
    const { db } = makeFakeDb({
      runs: [
        {
          id: 'run-1',
          repository: 'proompteng/lab',
          issue_number: 2137,
          branch: 'codex/issue-2137',
          attempt: 1,
          workflow_name: 'workflow-1',
          workflow_uid: null,
          workflow_namespace: null,
          stage: 'implementation',
          status: 'completed',
          phase: null,
          prompt: null,
          next_prompt: null,
          commit_sha: null,
          pr_number: null,
          pr_url: null,
          ci_status: null,
          ci_url: null,
          review_status: null,
          review_summary: {},
          notify_payload: null,
          run_complete_payload: null,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          started_at: '2025-01-01T00:00:00Z',
          finished_at: '2025-01-01T00:10:00Z',
        },
        {
          id: 'run-2',
          repository: 'proompteng/lab',
          issue_number: 2137,
          branch: 'codex/issue-2137',
          attempt: 2,
          workflow_name: 'workflow-2',
          workflow_uid: null,
          workflow_namespace: null,
          stage: 'implementation',
          status: 'needs_iteration',
          phase: null,
          prompt: null,
          next_prompt: null,
          commit_sha: null,
          pr_number: null,
          pr_url: null,
          ci_status: null,
          ci_url: null,
          review_status: null,
          review_summary: {},
          notify_payload: null,
          run_complete_payload: null,
          created_at: '2025-01-02T00:00:00Z',
          updated_at: '2025-01-02T00:00:00Z',
          started_at: '2025-01-02T00:00:00Z',
          finished_at: '2025-01-02T00:20:00Z',
        },
      ],
      artifacts: [
        {
          id: 'artifact-1',
          run_id: 'run-1',
          name: 'implementation-changes',
          key: 'artifact-key',
          bucket: 'codex',
          url: 'https://example.com/artifact',
          metadata: { size: 123 },
          created_at: '2025-01-01T00:00:00Z',
        },
      ],
      evaluations: [
        {
          id: 'eval-1',
          run_id: 'run-1',
          decision: 'pass',
          confidence: 0.1,
          reasons: { error: 'old_error' },
          missing_items: {},
          suggested_fixes: {},
          next_prompt: null,
          prompt_tuning: {},
          system_suggestions: {},
          created_at: '2025-01-01T00:05:00Z',
        },
        {
          id: 'eval-2',
          run_id: 'run-1',
          decision: 'pass',
          confidence: 0.9,
          reasons: {},
          missing_items: {},
          suggested_fixes: {},
          next_prompt: null,
          prompt_tuning: {},
          system_suggestions: {},
          created_at: '2025-01-01T00:06:00Z',
        },
        {
          id: 'eval-3',
          run_id: 'run-2',
          decision: 'needs_iteration',
          confidence: 0.3,
          reasons: { error: 'ci_failed' },
          missing_items: {},
          suggested_fixes: {},
          next_prompt: null,
          prompt_tuning: {},
          system_suggestions: {},
          created_at: '2025-01-02T00:05:00Z',
        },
      ],
    })

    const store = createCodexJudgeStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    const runs = await store.listRunHistory({
      repository: 'proompteng/lab',
      issueNumber: 2137,
      limit: 10,
    })

    const runOne = runs.find((run) => run.id === 'run-1')
    expect(runOne?.artifacts).toHaveLength(1)
    expect(runOne?.latestEvaluation?.id).toBe('eval-2')

    const runTwo = runs.find((run) => run.id === 'run-2')
    expect(runTwo?.artifacts).toHaveLength(0)
    expect(runTwo?.latestEvaluation?.id).toBe('eval-3')
  })

  it('computes stats from latest evaluations and run attempts', async () => {
    const { db } = makeFakeDb({
      runs: [
        {
          id: 'run-1',
          repository: 'proompteng/lab',
          issue_number: 2137,
          branch: 'codex/issue-2137',
          attempt: 1,
          workflow_name: 'workflow-1',
          workflow_uid: null,
          workflow_namespace: null,
          stage: 'implementation',
          status: 'completed',
          phase: null,
          prompt: null,
          next_prompt: null,
          commit_sha: null,
          pr_number: null,
          pr_url: null,
          ci_status: null,
          ci_url: null,
          review_status: null,
          review_summary: {},
          notify_payload: null,
          run_complete_payload: null,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          started_at: '2025-01-01T00:00:00Z',
          finished_at: '2025-01-01T00:10:00Z',
        },
        {
          id: 'run-2',
          repository: 'proompteng/lab',
          issue_number: 2137,
          branch: 'codex/issue-2137',
          attempt: 2,
          workflow_name: 'workflow-2',
          workflow_uid: null,
          workflow_namespace: null,
          stage: 'implementation',
          status: 'needs_iteration',
          phase: null,
          prompt: null,
          next_prompt: null,
          commit_sha: null,
          pr_number: null,
          pr_url: null,
          ci_status: null,
          ci_url: null,
          review_status: null,
          review_summary: {},
          notify_payload: null,
          run_complete_payload: null,
          created_at: '2025-01-02T00:00:00Z',
          updated_at: '2025-01-02T00:00:00Z',
          started_at: '2025-01-02T00:00:00Z',
          finished_at: '2025-01-02T00:20:00Z',
        },
      ],
      evaluations: [
        {
          id: 'eval-2',
          run_id: 'run-1',
          decision: 'pass',
          confidence: 0.9,
          reasons: {},
          missing_items: {},
          suggested_fixes: {},
          next_prompt: null,
          prompt_tuning: {},
          system_suggestions: {},
          created_at: '2025-01-01T00:06:00Z',
        },
        {
          id: 'eval-3',
          run_id: 'run-2',
          decision: 'needs_iteration',
          confidence: 0.3,
          reasons: { error: 'ci_failed' },
          missing_items: {},
          suggested_fixes: {},
          next_prompt: null,
          prompt_tuning: {},
          system_suggestions: {},
          created_at: '2025-01-02T00:05:00Z',
        },
      ],
    })

    const store = createCodexJudgeStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    const stats = await store.getRunStats({ repository: 'proompteng/lab', issueNumber: 2137 })

    expect(stats.completionRate).toBeCloseTo(0.5)
    expect(stats.avgAttemptsPerIssue).toBe(2)
    expect(stats.failureReasonCounts).toEqual({ ci_failed: 1 })
    expect(stats.avgCiDuration).toBe(900000)
    expect(stats.avgJudgeConfidence).toBeCloseTo(0.6)
  })
})
