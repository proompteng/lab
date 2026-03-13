import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createLogger } from './logger'
import type { SymphonyConfig } from './types'
import { WorkspaceManager } from './workspace-manager'

const makeConfig = (workspaceRoot: string): SymphonyConfig => ({
  workflowPath: path.join(workspaceRoot, 'WORKFLOW.md'),
  tracker: {
    kind: 'linear',
    endpoint: 'https://api.linear.app/graphql',
    apiKey: 'token',
    projectSlug: 'symphony',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done'],
  },
  pollingIntervalMs: 30_000,
  workspaceRoot,
  hooks: {
    afterCreate: 'echo after_create >> ../hooks.log',
    beforeRun: 'echo before_run >> ../hooks.log',
    afterRun: 'echo after_run >> ../hooks.log',
    beforeRemove: 'echo before_remove >> ../hooks.log',
    timeoutMs: 5_000,
  },
  worker: {
    sshHosts: [],
    maxConcurrentAgentsPerHost: null,
  },
  agent: {
    maxConcurrentAgents: 10,
    maxConcurrentAgentsByState: {},
    maxRetryBackoffMs: 300_000,
    maxTurns: 20,
  },
  codex: {
    command: 'codex app-server',
    approvalPolicy: 'never',
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: null,
    turnTimeoutMs: 3_600_000,
    readTimeoutMs: 5_000,
    stallTimeoutMs: 300_000,
  },
  server: {
    host: '127.0.0.1',
    port: null,
  },
})

describe('workspace manager', () => {
  let tempDir = ''
  let config: SymphonyConfig

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'symphony-workspace-'))
    config = makeConfig(tempDir)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('creates deterministic sanitized workspaces and runs hooks with correct lifecycle', async () => {
    const manager = new WorkspaceManager(async () => config, createLogger({ test: 'workspace' }))

    const first = await manager.createForIssue('ABC/123')
    expect(first.workspaceKey).toBe('ABC_123')
    expect(first.createdNow).toBe(true)
    expect(first.path).toBe(path.join(tempDir, 'ABC_123'))

    mkdirSync(path.join(first.path, 'tmp'), { recursive: true })
    mkdirSync(path.join(first.path, '.elixir_ls'), { recursive: true })

    const second = await manager.createForIssue('ABC/123')
    expect(second.createdNow).toBe(false)
    expect(existsSync(path.join(second.path, 'tmp'))).toBe(false)
    expect(existsSync(path.join(second.path, '.elixir_ls'))).toBe(false)

    await manager.runBeforeRun(second.path)
    await manager.runAfterRun(second.path)
    await manager.removeWorkspace('ABC/123')

    const hookLog = readFileSync(path.join(tempDir, 'hooks.log'), 'utf8').trim().split('\n')
    expect(hookLog).toEqual(['after_create', 'before_run', 'after_run', 'before_remove'])
  })
})
