import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { CodexAppServerOptions, CodexAppServerTurnOptions, StreamDelta, Turn } from '@proompteng/codex'
import { describe, expect, it } from 'vitest'

import { runCodexAppServerAdapter, type CodexAppServerRunnerClient } from './codex-app-server'

const makeStream = async function* (): AsyncGenerator<StreamDelta, Turn | null, void> {
  yield { type: 'message', delta: 'done' }
  return null
}

describe('codex app-server runner adapter', () => {
  it('maps run.json and runner adapter config into a Codex app-server turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-codex-runner-'))
    const runPath = join(dir, 'run.json')
    const statusPath = join(dir, 'status.json')
    const logPath = join(dir, 'runner.log')
    await writeFile(
      runPath,
      `${JSON.stringify({
        implementation: { text: 'implement the feature' },
        systemPrompt: 'system instructions',
        goal: { objective: 'ship the feature', tokenBudget: 1234 },
      })}\n`,
      'utf8',
    )

    const createdClients: CodexAppServerOptions[] = []
    const turnOptions: CodexAppServerTurnOptions[] = []
    const fakeClient: CodexAppServerRunnerClient = {
      runTurnStream: async (_prompt, options) => {
        turnOptions.push(options ?? {})
        return {
          stream: makeStream(),
          turnId: 'turn-1',
          threadId: 'thread-1',
        }
      },
      stop: () => undefined,
    }

    const exitCode = await runCodexAppServerAdapter(
      {
        provider: 'codex-runner',
        payloads: {
          eventFilePath: runPath,
        },
        artifacts: {
          statusPath,
          logPath,
        },
      },
      {
        model: 'gpt-5.5',
        effort: 'high',
        sandbox: 'danger-full-access',
        approval: 'never',
        cwd: '/workspace/lab',
        threadConfig: { web_search: 'live', mcp_servers: {} },
      },
      {
        createClient: (options) => {
          createdClients.push(options)
          return fakeClient
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(createdClients[0]).toMatchObject({
      defaultModel: 'gpt-5.5',
      defaultEffort: 'high',
      sandbox: 'danger-full-access',
      approval: 'never',
      cwd: '/workspace/lab',
      threadConfig: { web_search: 'live', mcp_servers: {} },
    })
    expect(turnOptions[0]).toMatchObject({
      model: 'gpt-5.5',
      effort: 'high',
      cwd: '/workspace/lab',
      baseInstructions: 'system instructions',
      goal: {
        objective: 'ship the feature',
        tokenBudget: 1234,
      },
    })

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as Record<string, unknown>
    expect(status).toMatchObject({
      provider: 'codex-runner',
      adapter: 'codex-app-server',
      exitCode: 0,
      status: 'succeeded',
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
    expect(await readFile(logPath, 'utf8')).toContain('"delta":"done"')
  })
})
