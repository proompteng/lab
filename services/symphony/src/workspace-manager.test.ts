import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Effect, Layer, ManagedRuntime } from 'effect'
import * as Stream from 'effect/Stream'

import { createLogger } from './logger'
import { makeTestConfig } from './test-fixtures'
import type { SymphonyConfig } from './types'
import { WorkflowService } from './workflow'
import { makeShellLayer, makeWorkspaceLayer, WorkspaceService } from './workspace-manager'

const makeConfig = (workspaceRoot: string): SymphonyConfig =>
  makeTestConfig({
    workflowPath: path.join(workspaceRoot, 'WORKFLOW.md'),
    workspaceRoot,
    tracker: {
      terminalStates: ['Done'],
    },
    hooks: {
      afterCreate: 'echo after_create >> ../hooks.log',
      beforeRun:
        'printf "before_run:%s:%s\\n" "${SYMPHONY_ISSUE_IDENTIFIER:-}" "${SYMPHONY_ISSUE_BRANCH_NAME:-}" >> ../hooks.log',
      afterRun: 'printf "after_run:%s\\n" "${SYMPHONY_ISSUE_STATE:-}" >> ../hooks.log',
      beforeRemove: 'printf "before_remove:%s\\n" "${SYMPHONY_ISSUE_IDENTIFIER:-}" >> ../hooks.log',
      timeoutMs: 5_000,
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
    const workflowLayer = Layer.succeed(WorkflowService, {
      current: Effect.succeed({ definition: { config: {}, promptTemplate: '' }, config }),
      config: Effect.succeed(config),
      reload: Effect.succeed({ definition: { config: {}, promptTemplate: '' }, config }),
      changes: Stream.empty,
    })
    const runtime = ManagedRuntime.make(
      makeWorkspaceLayer(createLogger({ test: 'workspace' }))
        .pipe(Layer.provide(makeShellLayer(createLogger({ test: 'workspace-shell' }))))
        .pipe(Layer.provide(workflowLayer)),
    )

    try {
      const first = await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* WorkspaceService
          return yield* manager.createForIssue('ABC/123')
        }),
      )
      expect(first.workspaceKey).toBe('ABC_123')
      expect(first.createdNow).toBe(true)
      expect(first.path).toBe(path.join(tempDir, 'ABC_123'))

      mkdirSync(path.join(first.path, 'tmp'), { recursive: true })
      mkdirSync(path.join(first.path, '.elixir_ls'), { recursive: true })

      const second = await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* WorkspaceService
          return yield* manager.createForIssue('ABC/123')
        }),
      )
      expect(second.createdNow).toBe(false)
      expect(existsSync(path.join(second.path, 'tmp'))).toBe(false)
      expect(existsSync(path.join(second.path, '.elixir_ls'))).toBe(false)

      await runtime.runPromise(
        Effect.gen(function* () {
          const manager = yield* WorkspaceService
          yield* manager.runBeforeRun(second.path, {
            issueIdentifier: 'ABC/123',
            issueBranchName: 'codex/abc-123',
            issueState: 'In Progress',
          })
          yield* manager.runAfterRun(second.path, {
            issueState: 'In Progress',
          })
          yield* manager.removeWorkspace('ABC/123')
        }),
      )

      const hookLog = readFileSync(path.join(tempDir, 'hooks.log'), 'utf8').trim().split('\n')
      expect(hookLog).toEqual([
        'after_create',
        'before_run:ABC/123:codex/abc-123',
        'after_run:In Progress',
        'before_remove:ABC/123',
      ])
    } finally {
      await runtime.dispose()
    }
  })
})
