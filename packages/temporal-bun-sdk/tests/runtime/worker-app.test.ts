import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit } from 'effect'

import { runWorkerApp } from '../../src/runtime/worker-app'

describe('runWorkerApp', () => {
  test('wires dependencies across the worker app layer', async () => {
    const exit = await Effect.runPromiseExit(
      runWorkerApp({
        config: {
          defaults: {
            address: 'temporal:7233',
            namespace: 'worker-app-test',
            taskQueue: 'worker-app-queue',
          },
          env: {},
        },
        worker: {
          workflowsPath: '',
          workflows: [],
        },
      }),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Cause.pretty(exit.cause)).toContain('No workflow definitions were registered; provide workflows or workflowsPath')
  })
})
