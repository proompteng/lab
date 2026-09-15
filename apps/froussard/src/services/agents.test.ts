import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GithubIssueAgentRunRequest } from '@/codex'
import {
  buildGithubIssueAgentRunPayload,
  buildLinearIssueAgentRunPayload,
  makeAgentsServiceSubmitter,
  type FroussardAgentsConfig,
  type LinearIssueAgentRunRequest,
} from './agents'

const { submitAgentRunToAgentsServiceMock } = vi.hoisted(() => ({
  submitAgentRunToAgentsServiceMock: vi.fn(),
}))

vi.mock('@proompteng/agent-contracts', () => ({
  submitAgentRunToAgentsService: submitAgentRunToAgentsServiceMock,
}))

const config: FroussardAgentsConfig = {
  serviceBaseUrl: 'http://agents.test',
  serviceClientName: 'froussard-test',
  namespace: 'agents',
  agentName: 'codex-agent',
  linearAgentName: 'codex-linear-agent',
  vcsProviderName: 'github',
  serviceAccountName: 'agents-sa',
  secrets: ['github-token', 'codex-auth'],
  secretBindingRef: 'codex-github-token',
  ttlSecondsAfterFinished: 86_400,
  goalTokenBudget: 250_000,
}

const request: GithubIssueAgentRunRequest = {
  stage: 'implementation',
  prompt: 'Implement this issue',
  repository: 'owner/repo',
  base: 'main',
  head: 'codex/issue-42-test',
  issueNumber: 42,
  issueUrl: 'https://github.com/owner/repo/issues/42',
  issueTitle: 'Ship the feature',
  issueBody: 'Detailed issue body',
  sender: 'tester',
  issuedAt: '2026-05-20T10:00:00.000Z',
  metadataVersion: 2,
  iterations: { mode: 'fixed', count: 1 },
}

const linearRequest: LinearIssueAgentRunRequest = {
  issueId: '2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9',
  identifier: 'PROOMPT-123',
  title: 'Ship Linear intake',
  description: 'Implement the issue exactly as described.',
  url: 'https://linear.app/proompteng/issue/PROOMPT-123/ship-linear-intake',
  action: 'update',
  repository: 'proompteng/lab',
  base: 'main',
  head: 'codex/linear-proompt-123-delivery',
}

describe('agents service submissions', () => {
  beforeEach(() => {
    submitAgentRunToAgentsServiceMock.mockReset()
  })

  it('maps a GitHub issue implementation request into an Agents AgentRun payload', () => {
    const payload = buildGithubIssueAgentRunPayload(config, request, 'delivery-42')

    expect(payload).toMatchObject({
      namespace: 'agents',
      agentRef: { name: 'codex-agent' },
      implementation: {
        summary: 'Ship the feature',
        text: 'Implement this issue',
        source: {
          provider: 'github',
          externalId: 'owner/repo#42',
          url: 'https://github.com/owner/repo/issues/42',
        },
        contract: {
          requiredKeys: ['repository', 'issueNumber', 'base', 'head', 'stage'],
        },
        metadata: {
          stage: 'implementation',
          deliveryId: 'delivery-42',
          sender: 'tester',
          issuedAt: '2026-05-20T10:00:00.000Z',
          metadataVersion: 2,
          iterations: { mode: 'fixed', count: 1 },
        },
      },
      goal: {
        objective: [
          'Implement GitHub issue owner/repo#42: Ship the feature.',
          'Issue URL: https://github.com/owner/repo/issues/42.',
          'Base branch: main.',
          'Head branch: codex/issue-42-test.',
          'Use implementation.text for the full issue body, requirements, and acceptance criteria.',
        ].join('\n'),
        tokenBudget: 250_000,
      },
      runtime: {
        type: 'job',
        config: {
          serviceAccountName: 'agents-sa',
        },
      },
      parameters: {
        repository: 'owner/repo',
        issueNumber: '42',
        issue_number: '42',
        base: 'main',
        head: 'codex/issue-42-test',
        stage: 'implementation',
        deliveryId: 'delivery-42',
        issueTitle: 'Ship the feature',
        issueUrl: 'https://github.com/owner/repo/issues/42',
        metadataVersion: '2',
      },
      secrets: ['github-token', 'codex-auth'],
      policy: { secretBindingRef: 'codex-github-token' },
      vcsRef: { name: 'github' },
      vcsPolicy: { required: true, mode: 'read-write' },
      ttlSecondsAfterFinished: 86_400,
    })
  })

  it('keeps long issue content out of AgentRun parameters and goal objective', () => {
    const longPrompt = 'Implement the issue.\n\n'.repeat(300)
    const payload = buildGithubIssueAgentRunPayload(
      config,
      { ...request, prompt: longPrompt, issueBody: longPrompt },
      'delivery-long',
    )

    expect(payload).toMatchObject({
      implementation: { text: longPrompt },
    })
    const goal = payload.goal as { objective: string }
    expect(goal.objective).not.toBe(longPrompt)
    expect(goal.objective).toContain('Implement GitHub issue owner/repo#42: Ship the feature.')
    expect(goal.objective).toContain('Use implementation.text for the full issue body')
    expect(goal.objective.length).toBeLessThanOrEqual(4000)

    const parameters = payload.parameters as Record<string, string>
    expect(parameters.codexPrompt).toBeUndefined()
    expect(parameters.codex_prompt).toBeUndefined()
    expect(parameters.issueBody).toBeUndefined()
    expect(Object.values(parameters).every((value) => new TextEncoder().encode(value).length <= 2048)).toBe(true)
  })

  it('caps the goal objective when issue metadata is unusually large', () => {
    const payload = buildGithubIssueAgentRunPayload(
      config,
      {
        ...request,
        issueTitle: 'large-title '.repeat(800),
      },
      'delivery-large-title',
    )
    const goal = payload.goal as { objective: string }

    expect(goal.objective).toContain('Implement GitHub issue owner/repo#42:')
    expect(goal.objective.length).toBeLessThanOrEqual(4000)
  })

  it('uses the configured Agents service endpoint and client name', async () => {
    submitAgentRunToAgentsServiceMock.mockResolvedValueOnce({ ok: true, status: 202, body: { name: 'run-1' } })
    const submitter = makeAgentsServiceSubmitter(config)
    const input = { payload: { namespace: 'agents' }, deliveryId: 'delivery-1' }

    await expect(submitter(input)).resolves.toEqual({ ok: true, status: 202, body: { name: 'run-1' } })
    expect(submitAgentRunToAgentsServiceMock).toHaveBeenCalledWith(input, {
      AGENTS_SERVICE_BASE_URL: 'http://agents.test',
      AGENTS_SERVICE_CLIENT_NAME: 'froussard-test',
    })
  })

  it('maps a Linear issue into an issue-only implementation source', () => {
    const payload = buildLinearIssueAgentRunPayload(config, linearRequest, 'linear-delivery-123')

    expect(payload).toEqual({
      namespace: 'agents',
      agentRef: { name: 'codex-linear-agent' },
      idempotencyKey: 'linear-delivery-123',
      implementation: {
        summary: 'Ship Linear intake',
        text: 'Implement the issue exactly as described.',
        source: {
          provider: 'linear',
          externalId: 'PROOMPT-123',
          url: 'https://linear.app/proompteng/issue/PROOMPT-123/ship-linear-intake',
        },
        contract: {
          requiredKeys: ['repository', 'base', 'head', 'stage'],
        },
        metadata: {
          issueId: '2174add1-f7c8-44e3-bbf3-2d60b5ea8bc9',
          deliveryId: 'linear-delivery-123',
          action: 'update',
          sourceVersion: 1,
        },
      },
      goal: {
        objective: [
          'Implement Linear issue PROOMPT-123: Ship Linear intake.',
          'Issue URL: https://linear.app/proompteng/issue/PROOMPT-123/ship-linear-intake.',
          'Base branch: main.',
          'Head branch: codex/linear-proompt-123-delivery.',
          'Use implementation.text for the full issue requirements and acceptance criteria.',
        ].join('\n'),
      },
      runtime: { type: 'job', config: {} },
      parameters: {
        repository: 'proompteng/lab',
        base: 'main',
        head: 'codex/linear-proompt-123-delivery',
        stage: 'implementation',
      },
      secrets: ['github-token', 'codex-auth'],
      policy: { secretBindingRef: 'codex-github-token' },
      vcsRef: { name: 'github' },
      vcsPolicy: { required: true, mode: 'read-write' },
      ttlSecondsAfterFinished: 86_400,
    })

    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain('team')
    expect(serialized).not.toContain('project')
    expect((payload.goal as Record<string, unknown>).tokenBudget).toBeUndefined()
    expect((payload.parameters as Record<string, unknown>).prompt).toBeUndefined()
    expect((payload.parameters as Record<string, unknown>).deliveryId).toBeUndefined()
  })
})
