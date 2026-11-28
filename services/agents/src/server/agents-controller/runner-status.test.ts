import { describe, expect, it, vi } from 'vitest'

import {
  extractRunnerStatusFromJobPods,
  mergeAgentRunArtifacts,
  parseRunnerTerminalStatus,
  runnerStatusForAgentRunStatus,
  runnerStatusToTerminalOutcome,
} from './runner-status'

describe('runner status extraction', () => {
  it('retains a bounded result preview and reports truncation', () => {
    const status = parseRunnerTerminalStatus({
      status: 'succeeded',
      result: { text: 'x'.repeat(512), truncated: false },
    })
    expect(status?.result).toEqual({ text: 'x'.repeat(256), truncated: true })
    expect(status && runnerStatusForAgentRunStatus(status).result).toEqual(status?.result)
    expect(parseRunnerTerminalStatus({ status: 'succeeded', result: { text: 'done' } })).toBeNull()
  })
  it('parses and sanitizes runner terminal status', () => {
    const status = parseRunnerTerminalStatus({
      provider: 'codex',
      adapter: 'codex-app-server',
      status: 'succeeded',
      exitCode: 0,
      threadId: 'thread-1',
      turnId: 'turn-1',
      artifacts: {
        statusPath: '/workspace/.agent/status.json',
        logPath: '/workspace/.agent/runner.log',
        outputArtifacts: [{ name: 'summary', key: 'runs/run-1/summary.json' }, 'bad'],
      },
    })

    expect(status).toEqual({
      provider: 'codex',
      adapter: 'codex-app-server',
      status: 'succeeded',
      exitCode: 0,
      threadId: 'thread-1',
      turnId: 'turn-1',
      artifacts: {
        statusPath: '/workspace/.agent/status.json',
        logPath: '/workspace/.agent/runner.log',
        outputArtifacts: [{ name: 'summary', key: 'runs/run-1/summary.json' }],
      },
    })
    expect(runnerStatusForAgentRunStatus(status!)).toMatchObject({ adapter: 'codex-app-server', threadId: 'thread-1' })
    expect(runnerStatusToTerminalOutcome(status!)).toEqual({
      phase: 'Succeeded',
      reason: 'Completed',
      conditionType: 'Succeeded',
    })
  })

  it('extracts preferred terminal status from job pod termination messages', async () => {
    const failed = JSON.stringify({ status: 'failed', adapter: 'exec', error: 'first attempt failed', exitCode: 1 })
    const succeeded = JSON.stringify({
      status: 'succeeded',
      adapter: 'codex-app-server',
      threadId: 'thread-2',
      exitCode: 0,
    })
    const kube = {
      logs: vi.fn(async () => ''),
      list: vi.fn(async () => ({
        items: [
          {
            metadata: { name: 'job-1-old-pod' },
            status: {
              startTime: '2026-05-19T12:00:00Z',
              containerStatuses: [{ name: 'agent-runner', state: { terminated: { message: failed } } }],
            },
          },
          {
            metadata: { name: 'job-1-new-pod' },
            status: {
              startTime: '2026-05-19T12:01:00Z',
              containerStatuses: [{ name: 'agent-runner', state: { terminated: { message: succeeded } } }],
            },
          },
        ],
      })),
    }

    await expect(extractRunnerStatusFromJobPods(kube, 'agents', 'job-1', ['succeeded'])).resolves.toMatchObject({
      status: 'succeeded',
      threadId: 'thread-2',
    })
    await expect(extractRunnerStatusFromJobPods(kube, 'agents', 'job-1', ['failed'])).resolves.toMatchObject({
      status: 'failed',
      error: 'first attempt failed',
    })
  })

  it('retries an unresolved status reference instead of accepting incomplete metadata', async () => {
    const kube = {
      logs: vi.fn(async () => '{"event":{"type":"runner_terminal_status","status":{"status":"succeeded"}}}\n'),
      list: vi.fn(async () => ({
        items: [
          {
            metadata: { name: 'pod' },
            status: {
              containerStatuses: [
                {
                  name: 'agent-runner',
                  state: { terminated: { message: JSON.stringify({ runnerStatusDigest: 'a'.repeat(64) }) } },
                },
              ],
            },
          },
        ],
      })),
    }
    await expect(extractRunnerStatusFromJobPods(kube, 'agents', 'job')).rejects.toThrow(
      'runner status log reference could not be resolved',
    )
  })

  it('maps failed and cancelled statuses to AgentRun terminal outcomes', () => {
    expect(runnerStatusToTerminalOutcome({ status: 'failed', error: 'app-server crashed' })).toEqual({
      phase: 'Failed',
      reason: 'RunnerFailed',
      message: 'app-server crashed',
      conditionType: 'Failed',
    })
    expect(runnerStatusToTerminalOutcome({ status: 'cancelled' })).toEqual({
      phase: 'Cancelled',
      reason: 'RunnerCancelled',
      message: 'agent runner cancelled',
      conditionType: 'Cancelled',
    })
  })

  it('merges output artifacts without duplicating existing status entries', () => {
    expect(
      mergeAgentRunArtifacts(
        [{ name: 'summary', key: 'runs/run-1/summary.json' }],
        [
          { name: 'summary', key: 'runs/run-1/summary.json' },
          { name: 'trace', path: '/workspace/trace.json' },
        ],
      ),
    ).toEqual([
      { name: 'summary', key: 'runs/run-1/summary.json' },
      { name: 'trace', path: '/workspace/trace.json' },
    ])
  })
})
