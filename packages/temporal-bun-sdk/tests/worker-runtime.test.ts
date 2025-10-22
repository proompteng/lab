#!/usr/bin/env bun

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkerRuntime, type WorkerRuntimeOptions } from '../src/worker/runtime.js'
import { ActivityTaskLoop, WorkflowIsolateManager, WorkflowTaskLoop } from '../src/worker/task-loops.js'

const TEST_WORKFLOWS_DIR = join(process.cwd(), 'packages/temporal-bun-sdk/.test-workflows')

describe('WorkerRuntime', () => {
  beforeAll(async () => {
    // Create test workflows directory
    if (existsSync(TEST_WORKFLOWS_DIR)) {
      rmSync(TEST_WORKFLOWS_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_WORKFLOWS_DIR, { recursive: true })

    // Create a simple test workflow
    const testWorkflow = `
export default async function helloWorkflow(name: string): Promise<string> {
  return \`Hello, \${name}!\`
}
`
    writeFileSync(join(TEST_WORKFLOWS_DIR, 'hello-workflow.ts'), testWorkflow)
  })

  afterAll(async () => {
    // Clean up test directory
    if (existsSync(TEST_WORKFLOWS_DIR)) {
      rmSync(TEST_WORKFLOWS_DIR, { recursive: true, force: true })
    }
  })

  test('should validate workflows path exists', async () => {
    const options: WorkerRuntimeOptions = {
      workflowsPath: '/nonexistent/path',
      activities: {},
    }

    await expect(WorkerRuntime.create(options)).rejects.toThrow()
  })

  test('should create WorkflowIsolateManager', async () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)
    expect(manager).toBeDefined()
    expect(manager).toBeInstanceOf(WorkflowIsolateManager)
  })

  test('should load workflow from file', async () => {
    const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Create a test workflow file
    const workflowContent = `
export default async function testWorkflow(input: string): Promise<string> {
  return \`Processed: \${input}\`
}
`
    writeFileSync(join(TEST_WORKFLOWS_DIR, 'test-workflow.ts'), workflowContent)

    // Test with the actual file name
    const workflowFn = await manager.loadWorkflow('test-workflow.ts')
    expect(typeof workflowFn).toBe('function')

    const result = await workflowFn('test input')
    expect(result).toBe('Processed: test input')
  })

  test('should handle WorkflowTaskLoop lifecycle', async () => {
    let pollCount = 0
    let handleCount = 0

    const pollTask = async () => {
      pollCount++
      return pollCount <= 2 ? { id: `task-${pollCount}` } : null
    }

    const handleTask = async (task: unknown) => {
      handleCount++
      expect(task.id).toBe(`task-${handleCount}`)
    }

    const loop = new WorkflowTaskLoop(pollTask, handleTask, { pollIntervalMs: 50 })

    // Start loop in background
    const _startPromise = loop.start()

    // Wait for tasks to be processed
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Stop loop
    await loop.stop()

    expect(pollCount).toBeGreaterThan(0)
    expect(handleCount).toBe(2)
  })

  test('should handle ActivityTaskLoop lifecycle', async () => {
    let pollCount = 0
    let handleCount = 0

    const pollTask = async () => {
      pollCount++
      return pollCount <= 2 ? { id: `activity-${pollCount}` } : null
    }

    const handleTask = async (task: unknown) => {
      handleCount++
      expect(task.id).toBe(`activity-${handleCount}`)
    }

    const loop = new ActivityTaskLoop(pollTask, handleTask, { pollIntervalMs: 50 })

    // Start loop in background
    const _startPromise = loop.start()

    // Wait for tasks to be processed
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Stop loop
    await loop.stop()

    expect(pollCount).toBeGreaterThan(0)
    expect(handleCount).toBe(2)
  })

  test('should handle loop errors gracefully', async () => {
    let pollCount = 0
    let errorOccurred = false

    const pollTask = async () => {
      pollCount++
      if (pollCount === 2) {
        errorOccurred = true
        throw new Error('Polling error')
      }
      return pollCount <= 4 ? { id: `task-${pollCount}` } : null
    }

    const handleTask = async (task: unknown) => {
      // Should not be called for task 2 due to error
      expect(task.id).not.toBe('task-2')
    }

    const loop = new WorkflowTaskLoop(pollTask, handleTask, { pollIntervalMs: 50 })

    // Start loop in background
    const _startPromise = loop.start()

    // Wait for error to occur and recovery
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Stop loop
    await loop.stop()

    // Should have encountered error
    expect(errorOccurred).toBe(true)
    expect(pollCount).toBeGreaterThanOrEqual(2)
  })
})
