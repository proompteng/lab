import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkerRuntime, type WorkerRuntimeOptions } from '../src/worker/runtime.js'
import { WorkflowIsolateManager } from '../src/worker/task-loops.js'

const TEST_WORKFLOWS_DIR = join(process.cwd(), 'packages/temporal-bun-sdk/.test-workflows')

describe('Worker Runtime Integration Tests', () => {
  beforeAll(async () => {
    // Create test workflows directory
    if (!existsSync(TEST_WORKFLOWS_DIR)) {
      mkdirSync(TEST_WORKFLOWS_DIR, { recursive: true })
    }

    // Create a test workflow file
    const testWorkflow = `
export async function testWorkflow(input: string): Promise<string> {
  return \`Hello, \${input}!\`
}
`
    writeFileSync(join(TEST_WORKFLOWS_DIR, 'test-workflow.ts'), testWorkflow)
  })

  afterAll(async () => {
    // Clean up test directory
    if (existsSync(TEST_WORKFLOWS_DIR)) {
      rmSync(TEST_WORKFLOWS_DIR, { recursive: true })
    }
  })

  test('should create WorkerRuntime with valid configuration', async () => {
    const options: WorkerRuntimeOptions = {
      namespace: 'test-namespace',
      taskQueue: 'test-queue',
      workflowsPath: TEST_WORKFLOWS_DIR,
      activities: new Map(),
      maxConcurrentWorkflowTasks: 1,
      maxConcurrentActivityTasks: 1,
    }

    const worker = await WorkerRuntime.create(options)

    expect(worker).toBeDefined()
    expect(worker.options).toEqual(options)
    expect(worker.workflowIsolateManager).toBeDefined()
    expect(worker.workflowTaskLoop).toBeDefined()
    expect(worker.activityTaskLoop).toBeDefined()
  })

  test('should validate workflows path exists', async () => {
    const options: WorkerRuntimeOptions = {
      namespace: 'test-namespace',
      taskQueue: 'test-queue',
      workflowsPath: '/nonexistent/path',
      activities: new Map(),
      maxConcurrentWorkflowTasks: 1,
      maxConcurrentActivityTasks: 1,
    }

    await expect(WorkerRuntime.create(options)).rejects.toThrow()
  })

  test('should load workflow from file', async () => {
    const isolateManager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    const workflow = await isolateManager.loadWorkflow('test-workflow.ts')

    expect(workflow).toBeDefined()
    expect(typeof workflow.testWorkflow).toBe('function')
  })

  test('should handle workflow execution', async () => {
    const isolateManager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Mock activation data
    const activation = {
      workflowType: 'test-workflow',
      input: 'World',
    }

    const result = await isolateManager.executeWorkflow('test-workflow.ts', activation)

    expect(result).toBe('Hello, World!')
  })

  test('should handle missing workflow file', async () => {
    const isolateManager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    await expect(isolateManager.loadWorkflow('nonexistent-workflow.ts')).rejects.toThrow()
  })

  test('should cache loaded workflows', async () => {
    const isolateManager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Load workflow twice
    const workflow1 = await isolateManager.loadWorkflow('test-workflow.ts')
    const workflow2 = await isolateManager.loadWorkflow('test-workflow.ts')

    // Should return the same instance (cached)
    expect(workflow1).toBe(workflow2)
  })

  test('should clear workflow cache', async () => {
    const isolateManager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

    // Load workflow
    await isolateManager.loadWorkflow('test-workflow.ts')

    // Clear cache
    isolateManager.clearCache()

    // Load again - should be a new instance
    const workflow = await isolateManager.loadWorkflow('test-workflow.ts')
    expect(workflow).toBeDefined()
  })

  test('should handle worker shutdown gracefully', async () => {
    const options: WorkerRuntimeOptions = {
      namespace: 'test-namespace',
      taskQueue: 'test-queue',
      workflowsPath: TEST_WORKFLOWS_DIR,
      activities: new Map(),
      maxConcurrentWorkflowTasks: 1,
      maxConcurrentActivityTasks: 1,
    }

    const worker = await WorkerRuntime.create(options)

    // Start the worker (this will start the task loops)
    const runPromise = worker.run()

    // Give it a moment to start
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Shutdown gracefully
    await worker.shutdown(1000)

    // The run promise should resolve (not hang)
    await expect(runPromise).resolves.toBeUndefined()
  })

  test('should handle worker shutdown timeout', async () => {
    const options: WorkerRuntimeOptions = {
      namespace: 'test-namespace',
      taskQueue: 'test-queue',
      workflowsPath: TEST_WORKFLOWS_DIR,
      activities: new Map(),
      maxConcurrentWorkflowTasks: 1,
      maxConcurrentActivityTasks: 1,
    }

    const worker = await WorkerRuntime.create(options)

    // Start the worker
    const runPromise = worker.run()

    // Give it a moment to start
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Shutdown with very short timeout
    await worker.shutdown(1)

    // The run promise should still resolve
    await expect(runPromise).resolves.toBeUndefined()
  })

  test('should handle multiple shutdown calls', async () => {
    const options: WorkerRuntimeOptions = {
      namespace: 'test-namespace',
      taskQueue: 'test-queue',
      workflowsPath: TEST_WORKFLOWS_DIR,
      activities: new Map(),
      maxConcurrentWorkflowTasks: 1,
      maxConcurrentActivityTasks: 1,
    }

    const worker = await WorkerRuntime.create(options)

    // Start the worker
    const runPromise = worker.run()

    // Give it a moment to start
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Call shutdown multiple times
    const shutdown1 = worker.shutdown(1000)
    const shutdown2 = worker.shutdown(1000)
    const shutdown3 = worker.shutdown(1000)

    // All should resolve
    await expect(shutdown1).resolves.toBeUndefined()
    await expect(shutdown2).resolves.toBeUndefined()
    await expect(shutdown3).resolves.toBeUndefined()

    // The run promise should resolve
    await expect(runPromise).resolves.toBeUndefined()
  })
})
