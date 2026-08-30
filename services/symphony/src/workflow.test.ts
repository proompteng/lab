import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Effect, ManagedRuntime } from 'effect'

import { createLogger } from './logger'
import { loadWorkflowFile, makeWorkflowLayer, WorkflowService } from './workflow'

describe('workflow loader', () => {
  let tempDir = ''

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'symphony-workflow-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('loadWorkflowFile parses front matter and trims prompt body', async () => {
    const workflowPath = path.join(tempDir, 'WORKFLOW.md')
    writeFileSync(
      workflowPath,
      [
        '---',
        'tracker:',
        '  kind: linear',
        'polling:',
        '  interval_ms: 15000',
        '---',
        '',
        'Work on {{issue.identifier}}.',
      ].join('\n'),
      'utf8',
    )

    const workflow = await loadWorkflowFile(workflowPath)
    expect(workflow.config.tracker).toEqual({ kind: 'linear' })
    expect(workflow.promptTemplate).toBe('Work on {{issue.identifier}}.')
  })

  test('WorkflowService keeps the last known good workflow on invalid reload', async () => {
    const workflowPath = path.join(tempDir, 'WORKFLOW.md')
    writeFileSync(
      workflowPath,
      ['---', 'tracker:', '  kind: linear', '  project_slug: symphony', '---', 'Initial prompt'].join('\n'),
      'utf8',
    )

    const runtime = ManagedRuntime.make(makeWorkflowLayer(workflowPath, createLogger({ test: 'workflow' })))
    try {
      const initial = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkflowService
          return yield* service.current
        }),
      )
      expect(initial.definition.promptTemplate).toBe('Initial prompt')

      await Bun.sleep(20)
      writeFileSync(workflowPath, ['---', '- invalid', '---', 'Broken'].join('\n'), 'utf8')
      await Bun.sleep(20)

      const current = await runtime.runPromise(
        Effect.gen(function* () {
          const service = yield* WorkflowService
          return yield* service.current
        }),
      )

      expect(current.definition.promptTemplate).toBe('Initial prompt')
      expect(current.config.tracker.projectSlug).toBe('symphony')
    } finally {
      await runtime.dispose()
    }
  })
})
