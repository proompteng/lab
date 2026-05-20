import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexRunRecord } from '@proompteng/agent-contracts/codex-runs-client'

import { getGithubPullJudgeRunsHandler } from '~/routes/api/github/pulls/$owner/$repo/$number/judge-runs'

const buildRun = (overrides: Partial<CodexRunRecord> = {}): CodexRunRecord => ({
  id: 'run-1',
  repository: 'owner/repo',
  issueNumber: 42,
  branch: 'codex/example',
  attempt: 1,
  agentRunName: 'agent-run-1',
  agentRunUid: null,
  agentRunNamespace: 'agents',
  turnId: null,
  threadId: null,
  stage: null,
  status: 'run_complete',
  phase: null,
  iteration: null,
  iterationCycle: null,
  prompt: null,
  nextPrompt: null,
  commitSha: null,
  prNumber: 42,
  prUrl: null,
  ciStatus: null,
  ciUrl: null,
  ciStatusUpdatedAt: null,
  reviewStatus: null,
  reviewSummary: {},
  reviewStatusUpdatedAt: null,
  notifyPayload: null,
  runCompletePayload: null,
  createdAt: '2026-05-20T00:00:00.000Z',
  updatedAt: '2026-05-20T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  ...overrides,
})

describe('GitHub pull judge runs route', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('forwards pull judge-run lookup to the Agents Codex projection API', async () => {
    vi.stubEnv('JANGAR_GITHUB_REPOS_ALLOWED', 'owner/repo')
    const runs = [buildRun()]
    const client = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      body: { ok: true, runs },
    }))

    const response = await getGithubPullJudgeRunsHandler({ owner: 'owner', repo: 'repo', number: '42' }, client)

    expect(client).toHaveBeenCalledWith({ repository: 'owner/repo', prNumber: 42 })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, runs })
  })

  it('rejects disallowed repositories before calling Agents', async () => {
    vi.stubEnv('JANGAR_GITHUB_REPOS_ALLOWED', 'other/repo')
    const client = vi.fn()

    const response = await getGithubPullJudgeRunsHandler({ owner: 'owner', repo: 'repo', number: '42' }, client)

    expect(client).not.toHaveBeenCalled()
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'Repository not allowed' })
  })
})
