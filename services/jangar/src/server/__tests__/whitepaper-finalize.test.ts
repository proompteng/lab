import { afterEach, describe, expect, it, vi } from 'vitest'

import { maybeFinalizeWhitepaperRun } from '~/server/whitepaper-finalize'

const ORIGINAL_ENV = { ...process.env }

const encodeBase64 = (value: string) => Buffer.from(value, 'utf8').toString('base64')

const buildAgentRun = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: { name: 'run-1', namespace: 'agents' },
  spec: {
    parameters: {
      runId: 'wp-abc123',
      repository: 'proompteng/lab',
      head: 'codex-whitepaper-abc',
      base: 'main',
    },
  },
  status: { phase: 'Running' },
  ...overrides,
})

describe('whitepaper finalize domain hook', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.env = { ...ORIGINAL_ENV }
  })

  it('finalizes successful whitepaper AgentRuns with GitHub outputs and PR metadata', async () => {
    const synthesis = { run_id: 'wp-abc123', executive_summary: 'summary' }
    const verdict = { run_id: 'wp-abc123', verdict: 'conditional_implement', confidence: 0.81 }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/contents/docs%2Fwhitepapers%2Fwp-abc123%2Fsynthesis.json')) {
        return new Response(JSON.stringify({ content: encodeBase64(JSON.stringify(synthesis)), sha: 'sha-synth' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/contents/docs%2Fwhitepapers%2Fwp-abc123%2Fverdict.json')) {
        return new Response(JSON.stringify({ content: encodeBase64(JSON.stringify(verdict)), sha: 'sha-verdict' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/pulls?head=proompteng%3Acodex-whitepaper-abc')) {
        return new Response(
          JSON.stringify([
            {
              number: 4242,
              url: 'https://api.github.com/repos/proompteng/lab/pulls/4242',
              html_url: 'https://github.com/proompteng/lab/pull/4242',
              head: { sha: 'abc123', ref: 'codex-whitepaper-abc' },
              base: { ref: 'main' },
              state: 'open',
              title: 'whitepaper output',
              body: 'body',
              mergeable_state: 'clean',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === 'http://torghut.local/whitepapers/runs/wp-abc123/finalize') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })

    vi.stubGlobal('fetch', fetchMock)
    process.env.GITHUB_TOKEN = 'github-token'
    process.env.JANGAR_WHITEPAPER_FINALIZE_ENABLED = 'true'
    process.env.JANGAR_WHITEPAPER_FINALIZE_BASE_URL = 'http://torghut.local'
    process.env.TORGHUT_COMMAND_API_TOKEN = 'whitepaper-token'

    await maybeFinalizeWhitepaperRun({
      resource: buildAgentRun(),
      nextStatus: { phase: 'Succeeded', artifacts: [{ name: 'synthesis', key: 'object-key' }] },
      previousPhase: 'Running',
      nextPhase: 'Succeeded',
    })

    const finalizeCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/whitepapers/runs/wp-abc123/finalize'),
    )
    expect(finalizeCall).toBeDefined()
    const [, init] = finalizeCall as unknown as [RequestInfo | URL, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer whitepaper-token')
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(payload).toEqual(
      expect.objectContaining({
        status: 'completed',
        source: 'jangar-whitepaper-finalize-consumer',
        repository: 'proompteng/lab',
        head_branch: 'codex-whitepaper-abc',
        synthesis,
        verdict,
        design_pull_request: expect.objectContaining({ pr_number: 4242 }),
      }),
    )
    expect(payload.artifacts).toEqual([
      expect.objectContaining({
        artifact_role: 'synthesis',
        ceph_object_key: 'object-key',
      }),
    ])
  })
})
