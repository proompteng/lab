import { describe, expect, it, vi } from 'vitest'

import type { CodexRunRecord } from '../codex-run-projection-store'

import { postCodexGithubEventsHandler } from './codex-github-events'

const run: CodexRunRecord = {
  id: 'codex-run-1',
  repository: 'owner/repo',
  issueNumber: 123,
  branch: 'codex/split',
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
  prNumber: null,
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
}

const createStore = () => ({
  ready: Promise.resolve(),
  close: vi.fn(async () => {}),
  listRunsByBranch: vi.fn(async () => [run]),
  listRunsByCommitSha: vi.fn(async () => [run]),
  listRunsByPrNumber: vi.fn(async () => [run]),
  updateCiStatus: vi.fn(async () => ({ ...run, ciStatus: 'success' })),
  updateReviewStatus: vi.fn(async () => ({ ...run, reviewStatus: 'commented' })),
  updateRunPrInfo: vi.fn(async () => ({ ...run, prNumber: 7299 })),
})

const request = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Request('http://agents.test/v1/codex/github-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })

describe('Codex GitHub events v1 API', () => {
  it('projects pull request events into Agents-owned Codex runs', async () => {
    const store = createStore()

    const response = await postCodexGithubEventsHandler(
      request({
        event: 'pull_request',
        action: 'opened',
        payload: {
          repository: { full_name: 'owner/repo' },
          pull_request: {
            number: 7299,
            html_url: 'https://github.com/owner/repo/pull/7299',
            state: 'open',
            merged: false,
            head: { ref: 'codex/split', sha: 'abcdef1234567890' },
          },
        },
      }),
      { storeFactory: () => store },
    )

    expect(response.status).toBe(202)
    expect(store.listRunsByBranch).toHaveBeenCalledWith('owner/repo', 'codex/split')
    expect(store.updateRunPrInfo).toHaveBeenCalledWith(
      'codex-run-1',
      7299,
      'https://github.com/owner/repo/pull/7299',
      'abcdef1234567890',
      'open',
      false,
    )
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      event: 'pull_request',
      updatedRunIds: ['codex-run-1'],
    })
  })

  it('projects completed check events into Agents-owned Codex CI status', async () => {
    const store = createStore()

    const response = await postCodexGithubEventsHandler(
      request({
        event: 'check_run',
        action: 'completed',
        payload: {
          repository: { full_name: 'owner/repo' },
          check_run: {
            head_sha: 'abcdef1234567890',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/owner/repo/actions/runs/1',
            pull_requests: [{ number: 7299 }],
          },
        },
      }),
      { storeFactory: () => store },
    )

    expect(response.status).toBe(202)
    expect(store.listRunsByCommitSha).toHaveBeenCalledWith('owner/repo', 'abcdef1234567890')
    expect(store.updateCiStatus).toHaveBeenCalledWith({
      runId: 'codex-run-1',
      status: 'success',
      url: 'https://github.com/owner/repo/actions/runs/1',
      commitSha: 'abcdef1234567890',
    })
  })

  it('accepts raw GitHub webhook payloads from the shared webhook topic', async () => {
    const store = createStore()

    const response = await postCodexGithubEventsHandler(
      request(
        {
          action: 'synchronize',
          repository: { full_name: 'owner/repo' },
          pull_request: {
            number: 7299,
            html_url: 'https://github.com/owner/repo/pull/7299',
            state: 'open',
            merged: false,
            head: { ref: 'codex/split', sha: 'abcdef1234567890' },
          },
        },
        {
          'x-github-delivery': 'delivery-raw-pr',
          'x-github-event': 'pull_request',
        },
      ),
      { storeFactory: () => store },
    )

    expect(response.status).toBe(202)
    expect(store.listRunsByBranch).toHaveBeenCalledWith('owner/repo', 'codex/split')
    expect(store.updateRunPrInfo).toHaveBeenCalledWith(
      'codex-run-1',
      7299,
      'https://github.com/owner/repo/pull/7299',
      'abcdef1234567890',
      'open',
      false,
    )
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      event: 'pull_request',
      action: 'synchronize',
      updatedRunIds: ['codex-run-1'],
    })
  })

  it('infers supported raw GitHub event types when Kafka headers are not preserved', async () => {
    const store = createStore()

    const response = await postCodexGithubEventsHandler(
      request({
        action: 'completed',
        repository: { full_name: 'owner/repo' },
        check_run: {
          head_sha: 'abcdef1234567890',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/owner/repo/actions/runs/1',
          pull_requests: [{ number: 7299 }],
        },
      }),
      { storeFactory: () => store },
    )

    expect(response.status).toBe(202)
    expect(store.listRunsByCommitSha).toHaveBeenCalledWith('owner/repo', 'abcdef1234567890')
    expect(store.updateCiStatus).toHaveBeenCalledWith({
      runId: 'codex-run-1',
      status: 'success',
      url: 'https://github.com/owner/repo/actions/runs/1',
      commitSha: 'abcdef1234567890',
    })
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      event: 'check_run',
      action: 'completed',
    })
  })

  it('accepts CloudEvent-wrapped raw GitHub events from Knative KafkaSource delivery', async () => {
    const store = createStore()

    const response = await postCodexGithubEventsHandler(
      request(
        {
          specversion: '1.0',
          id: 'ce-delivery',
          type: 'dev.knative.kafka.event',
          data: {
            action: 'submitted',
            repository: { full_name: 'owner/repo' },
            pull_request: {
              number: 7299,
              html_url: 'https://github.com/owner/repo/pull/7299',
              state: 'open',
              merged: false,
              head: { ref: 'codex/split', sha: 'abcdef1234567890' },
            },
            review: { state: 'approved' },
          },
        },
        {
          'ce-xgithubevent': 'pull_request_review',
          'ce-xgithubdelivery': 'delivery-cloud-event',
        },
      ),
      { storeFactory: () => store },
    )

    expect(response.status).toBe(202)
    expect(store.listRunsByPrNumber).toHaveBeenCalledWith('owner/repo', 7299)
    expect(store.updateReviewStatus).toHaveBeenCalledWith({
      runId: 'codex-run-1',
      status: 'approved',
      summary: { event: 'pull_request_review', action: 'submitted', deliveryId: 'delivery-cloud-event' },
    })
  })

  it.each(['ping', 'push', 'workflow_run', 'workflow_job'])(
    'acknowledges irrelevant %s events without opening storage',
    async (event) => {
      const storeFactory = vi.fn(() => createStore())

      const response = await postCodexGithubEventsHandler(request({ event, payload: {} }), { storeFactory })

      expect(response.status).toBe(202)
      await expect(response.json()).resolves.toMatchObject({ ok: true, event, ignored: true, updatedRunIds: [] })
      expect(storeFactory).not.toHaveBeenCalled()
    },
  )

  it.each(['workflow_run', 'workflow_job'])(
    'recognizes raw %s events when Kafka event headers are absent',
    async (event) => {
      const storeFactory = vi.fn(() => createStore())

      const response = await postCodexGithubEventsHandler(
        request({ action: 'in_progress', [event]: { id: 1 }, repository: { full_name: 'owner/repo' } }),
        { storeFactory },
      )

      expect(response.status).toBe(202)
      await expect(response.json()).resolves.toMatchObject({ ok: true, event, ignored: true })
      expect(storeFactory).not.toHaveBeenCalled()
    },
  )

  it('recognizes raw push events without confusing them with missing event metadata', async () => {
    const storeFactory = vi.fn(() => createStore())
    const response = await postCodexGithubEventsHandler(
      request({ ref: 'refs/heads/main', before: 'abcdef0', after: 'abcdef1', commits: [] }),
      { storeFactory },
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ ok: true, event: 'push', ignored: true })
    expect(storeFactory).not.toHaveBeenCalled()
  })

  it.each([{ event: 'unrecognized_event', payload: {} }, {}, { ref: 'refs/heads/main' }])(
    'rejects unrecognized or missing event metadata before opening storage: %j',
    async (payload) => {
      const storeFactory = vi.fn(() => createStore())
      const response = await postCodexGithubEventsHandler(request(payload), { storeFactory })

      expect(response.status).toBe(422)
      expect(storeFactory).not.toHaveBeenCalled()
    },
  )

  it('recognizes workflow events wrapped in a structured CloudEvent', async () => {
    const storeFactory = vi.fn(() => createStore())
    const response = await postCodexGithubEventsHandler(
      request({ specversion: '1.0', type: 'dev.knative.kafka.event', data: { workflow_run: { id: 1 } } }),
      { storeFactory },
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ ok: true, event: 'workflow_run', ignored: true })
    expect(storeFactory).not.toHaveBeenCalled()
  })

  it('normalizes qualified workflow event names', async () => {
    const storeFactory = vi.fn(() => createStore())
    const response = await postCodexGithubEventsHandler(request({ event: 'github.workflow_run', payload: {} }), {
      storeFactory,
    })

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ ok: true, event: 'workflow_run', ignored: true })
    expect(storeFactory).not.toHaveBeenCalled()
  })
})
