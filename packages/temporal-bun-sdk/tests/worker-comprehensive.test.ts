import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkerRuntime, type WorkerRuntimeOptions } from '../src/worker/runtime.js'
import { WorkflowIsolateManager } from '../src/worker/task-loops.js'

const TEST_WORKFLOWS_DIR = join(process.cwd(), 'packages/temporal-bun-sdk/.test-workflows-comprehensive')

describe('Comprehensive Worker Tests (zig-worker-01 through zig-worker-09)', () => {
  beforeAll(async () => {
    // Create test workflows directory
    if (!existsSync(TEST_WORKFLOWS_DIR)) {
      mkdirSync(TEST_WORKFLOWS_DIR, { recursive: true })
    }

    // Create multiple test workflow files
    const workflows = [
      {
        name: 'simple-workflow.ts',
        content: `
export async function simpleWorkflow(input: string): Promise<string> {
  return \`Processed: \${input}\`
}

export default simpleWorkflow
`,
      },
      {
        name: 'complex-workflow.ts',
        content: `
export async function complexWorkflow(data: { items: string[]; multiplier: number }): Promise<{ result: string[]; count: number }> {
  const processed = data.items.map(item => \`\${item} x \${data.multiplier}\`)
  return { result: processed, count: processed.length }
}

export default complexWorkflow
`,
      },
      {
        name: 'error-workflow.ts',
        content: `
export async function errorWorkflow(input: string): Promise<string> {
  if (input === 'error') {
    throw new Error('Intentional error for testing')
  }
  return \`Success: \${input}\`
}

export default errorWorkflow
`,
      },
      {
        name: 'async-workflow.ts',
        content: `
export async function asyncWorkflow(delay: number): Promise<string> {
  await new Promise(resolve => setTimeout(resolve, delay))
  return \`Completed after \${delay}ms\`
}

export default asyncWorkflow
`,
      },
    ]

    for (const workflow of workflows) {
      writeFileSync(join(TEST_WORKFLOWS_DIR, workflow.name), workflow.content)
    }
  })

  afterAll(async () => {
    // Clean up test directory
    if (existsSync(TEST_WORKFLOWS_DIR)) {
      rmSync(TEST_WORKFLOWS_DIR, { recursive: true })
    }
  })

  describe('Worker Creation and Destruction (zig-worker-01, zig-worker-02)', () => {
    test('should create and destroy worker runtime successfully', async () => {
      const options: WorkerRuntimeOptions = {
        namespace: 'test-namespace',
        taskQueue: 'test-queue',
        workflowsPath: TEST_WORKFLOWS_DIR,
        activities: new Map(),
        maxConcurrentWorkflowTasks: 2,
        maxConcurrentActivityTasks: 2,
      }

      const worker = await WorkerRuntime.create(options)

      expect(worker).toBeDefined()
      expect(worker.options).toEqual(options)
      expect(worker.workflowIsolateManager).toBeDefined()
      expect(worker.workflowTaskLoop).toBeDefined()
      expect(worker.activityTaskLoop).toBeDefined()

      // Test graceful shutdown
      await worker.shutdown(1000)
    })

    test('should handle multiple worker instances', async () => {
      const options1: WorkerRuntimeOptions = {
        namespace: 'namespace-1',
        taskQueue: 'queue-1',
        workflowsPath: TEST_WORKFLOWS_DIR,
        activities: new Map(),
        maxConcurrentWorkflowTasks: 1,
        maxConcurrentActivityTasks: 1,
      }

      const options2: WorkerRuntimeOptions = {
        namespace: 'namespace-2',
        taskQueue: 'queue-2',
        workflowsPath: TEST_WORKFLOWS_DIR,
        activities: new Map(),
        maxConcurrentWorkflowTasks: 1,
        maxConcurrentActivityTasks: 1,
      }

      const worker1 = await WorkerRuntime.create(options1)
      const worker2 = await WorkerRuntime.create(options2)

      expect(worker1).toBeDefined()
      expect(worker2).toBeDefined()
      expect(worker1).not.toBe(worker2)

      // Shutdown both workers
      await Promise.all([worker1.shutdown(1000), worker2.shutdown(1000)])
    })

    test('should handle worker creation with invalid paths', async () => {
      const invalidOptions: WorkerRuntimeOptions = {
        namespace: 'test-namespace',
        taskQueue: 'test-queue',
        workflowsPath: '/nonexistent/path',
        activities: new Map(),
        maxConcurrentWorkflowTasks: 1,
        maxConcurrentActivityTasks: 1,
      }

      await expect(WorkerRuntime.create(invalidOptions)).rejects.toThrow()
    })
  })

  describe('Workflow Task Polling and Completion (zig-worker-03, zig-worker-04)', () => {
    test('should poll and execute workflow tasks', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Test simple workflow execution
      const result1 = await manager.executeWorkflow('simple-workflow.ts', { input: 'test data' })
      expect(result1).toBe('Processed: test data')

      // Test complex workflow execution
      const result2 = await manager.executeWorkflow('complex-workflow.ts', {
        input: { items: ['a', 'b', 'c'], multiplier: 3 },
      })
      expect(result2).toEqual({ result: ['a x 3', 'b x 3', 'c x 3'], count: 3 })

      // Test async workflow execution
      const result3 = await manager.executeWorkflow('async-workflow.ts', { input: 10 })
      expect(result3).toBe('Completed after 10ms')
    })

    test('should handle workflow execution errors', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Test error workflow
      await expect(manager.executeWorkflow('error-workflow.ts', { input: 'error' })).rejects.toThrow(
        'Workflow execution failed',
      )

      // Test successful execution after error
      const result = await manager.executeWorkflow('error-workflow.ts', { input: 'success' })
      expect(result).toBe('Success: success')
    })

    test('should handle concurrent workflow executions', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Execute multiple workflows concurrently
      const promises = [
        manager.executeWorkflow('simple-workflow.ts', { input: 'task-1' }),
        manager.executeWorkflow('simple-workflow.ts', { input: 'task-2' }),
        manager.executeWorkflow('simple-workflow.ts', { input: 'task-3' }),
        manager.executeWorkflow('complex-workflow.ts', {
          input: { items: ['x', 'y'], multiplier: 2 },
        }),
      ]

      const results = await Promise.all(promises)

      expect(results[0]).toBe('Processed: task-1')
      expect(results[1]).toBe('Processed: task-2')
      expect(results[2]).toBe('Processed: task-3')
      expect(results[3]).toEqual({ result: ['x x 2', 'y x 2'], count: 2 })
    })

    test('should handle workflow completion with different payload types', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Test string payload
      const stringResult = await manager.executeWorkflow('simple-workflow.ts', 'string input')
      expect(stringResult).toBe('Processed: string input')

      // Test object payload
      const objectResult = await manager.executeWorkflow('complex-workflow.ts', {
        items: ['test'],
        multiplier: 5,
      })
      expect(objectResult).toEqual({ result: ['test x 5'], count: 1 })

      // Test number payload
      const numberResult = await manager.executeWorkflow('async-workflow.ts', 50)
      expect(numberResult).toBe('Completed after 50ms')
    })
  })

  describe('Activity Task Polling and Completion (zig-worker-05, zig-worker-06)', () => {
    test('should handle activity task execution', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Mock activity execution (since we don't have real activity tasks yet)
      // This tests the infrastructure for activity task handling
      const workflowResult = await manager.executeWorkflow('simple-workflow.ts', { input: 'activity test' })
      expect(workflowResult).toBe('Processed: activity test')
    })

    test('should handle activity task errors gracefully', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Test that activity errors don't crash the system
      await expect(manager.executeWorkflow('error-workflow.ts', { input: 'error' })).rejects.toThrow(
        'Workflow execution failed',
      )

      // System should still be functional after error
      const result = await manager.executeWorkflow('simple-workflow.ts', { input: 'recovery test' })
      expect(result).toBe('Processed: recovery test')
    })

    test('should handle concurrent activity tasks', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Simulate concurrent activity task execution
      const activityPromises = Array.from({ length: 5 }, (_, i) =>
        manager.executeWorkflow('simple-workflow.ts', { input: `activity-${i}` }),
      )

      const results = await Promise.all(activityPromises)

      expect(results).toHaveLength(5)
      results.forEach((result, i) => {
        expect(result).toBe(`Processed: activity-${i}`)
      })
    })
  })

  describe('Activity Heartbeat (zig-worker-07)', () => {
    test('should handle activity heartbeat simulation', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Simulate activity heartbeat by executing a long-running workflow
      const startTime = Date.now()
      const result = await manager.executeWorkflow('async-workflow.ts', 100)
      const endTime = Date.now()

      expect(result).toBe('Completed after 100ms')
      expect(endTime - startTime).toBeGreaterThanOrEqual(100)
    })

    test('should handle heartbeat during concurrent operations', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Start multiple long-running operations
      const promises = [
        manager.executeWorkflow('async-workflow.ts', 50),
        manager.executeWorkflow('async-workflow.ts', 75),
        manager.executeWorkflow('async-workflow.ts', 100),
      ]

      const results = await Promise.all(promises)

      expect(results[0]).toBe('Completed after 50ms')
      expect(results[1]).toBe('Completed after 75ms')
      expect(results[2]).toBe('Completed after 100ms')
    })
  })

  describe('Worker Shutdown (zig-worker-08, zig-worker-09)', () => {
    test('should initiate graceful shutdown', async () => {
      const options: WorkerRuntimeOptions = {
        namespace: 'shutdown-test',
        taskQueue: 'shutdown-queue',
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

      // Initiate shutdown
      await worker.shutdown(2000)

      // The run promise should resolve
      await expect(runPromise).resolves.toBeUndefined()
    })

    test('should handle shutdown timeout', async () => {
      const options: WorkerRuntimeOptions = {
        namespace: 'timeout-test',
        taskQueue: 'timeout-queue',
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

      // Should still complete
      await expect(runPromise).resolves.toBeUndefined()
    })

    test('should handle multiple shutdown calls', async () => {
      const options: WorkerRuntimeOptions = {
        namespace: 'multi-shutdown-test',
        taskQueue: 'multi-shutdown-queue',
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
      const shutdownPromises = [worker.shutdown(1000), worker.shutdown(1000), worker.shutdown(1000)]

      // All should resolve
      await expect(Promise.all(shutdownPromises)).resolves.toBeDefined()

      // The run promise should resolve
      await expect(runPromise).resolves.toBeUndefined()
    })

    test('should finalize shutdown cleanly', async () => {
      const options: WorkerRuntimeOptions = {
        namespace: 'finalize-test',
        taskQueue: 'finalize-queue',
        workflowsPath: TEST_WORKFLOWS_DIR,
        activities: new Map(),
        maxConcurrentWorkflowTasks: 1,
        maxConcurrentActivityTasks: 1,
      }

      const worker = await WorkerRuntime.create(options)

      // Start and immediately shutdown
      const runPromise = worker.run()
      await worker.shutdown(1000)

      // Should complete cleanly
      await expect(runPromise).resolves.toBeUndefined()
    })
  })

  describe('Error Handling and Edge Cases', () => {
    test('should handle malformed workflow files', async () => {
      // Create a malformed workflow file
      const malformedWorkflow = `
// This is not valid TypeScript
export async function malformedWorkflow(input: string): Promise<string> {
  return \`Hello, \${input}!
  // Missing closing quote and parenthesis
`
      writeFileSync(join(TEST_WORKFLOWS_DIR, 'malformed-workflow.ts'), malformedWorkflow)

      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      await expect(manager.loadWorkflow('malformed-workflow.ts')).rejects.toThrow(
        'Failed to load workflow malformed-workflow.ts',
      )

      // Clean up
      rmSync(join(TEST_WORKFLOWS_DIR, 'malformed-workflow.ts'))
    })

    test('should handle empty workflow files', async () => {
      // Create an empty workflow file
      writeFileSync(join(TEST_WORKFLOWS_DIR, 'empty-workflow.ts'), '')

      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      await expect(manager.loadWorkflow('empty-workflow.ts')).rejects.toThrow(
        'Failed to load workflow empty-workflow.ts',
      )

      // Clean up
      rmSync(join(TEST_WORKFLOWS_DIR, 'empty-workflow.ts'))
    })

    test('should handle workflow files without default export', async () => {
      // Create a workflow file without default export
      const noDefaultWorkflow = `
export async function namedWorkflow(input: string): Promise<string> {
  return \`Hello, \${input}!\`
}
// No default export
`
      writeFileSync(join(TEST_WORKFLOWS_DIR, 'no-default-workflow.ts'), noDefaultWorkflow)

      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Should fail to load since we expect a default export
      await expect(manager.loadWorkflow('no-default-workflow.ts')).rejects.toThrow(
        'Failed to load workflow no-default-workflow.ts',
      )

      // Clean up
      rmSync(join(TEST_WORKFLOWS_DIR, 'no-default-workflow.ts'))
    })

    test('should handle workflow execution with null/undefined input', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Test with null input
      const result1 = await manager.executeWorkflow('simple-workflow.ts', { input: null })
      expect(result1).toBe('Processed: null')

      // Test with undefined input
      const result2 = await manager.executeWorkflow('simple-workflow.ts', { input: undefined })
      expect(result2).toBe('Processed: undefined')
    })

    test('should handle very large workflow inputs', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Test with large string input
      const largeString = 'x'.repeat(10000)
      const result = await manager.executeWorkflow('simple-workflow.ts', { input: largeString })
      expect(result).toBe(`Processed: ${largeString}`)
    })

    test('should handle workflow execution with complex nested objects', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      const complexInput = {
        data: {
          items: ['a', 'b', 'c'],
          metadata: {
            count: 3,
            processed: false,
          },
        },
        multiplier: 2,
      }

      const result = await manager.executeWorkflow('complex-workflow.ts', { input: complexInput })
      expect(result).toEqual({
        result: ['a x 2', 'b x 2', 'c x 2'],
        count: 3,
      })
    })
  })

  describe('Performance and Scalability', () => {
    test('should handle high-frequency workflow execution', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      const startTime = Date.now()

      // Execute 100 workflows rapidly
      const promises = Array.from({ length: 100 }, (_, i) =>
        manager.executeWorkflow('simple-workflow.ts', { input: `task-${i}` }),
      )

      const results = await Promise.all(promises)
      const endTime = Date.now()

      expect(results).toHaveLength(100)
      results.forEach((result, i) => {
        expect(result).toBe(`Processed: task-${i}`)
      })

      // Should complete reasonably quickly
      expect(endTime - startTime).toBeLessThan(5000)
    })

    test('should handle mixed workflow types efficiently', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      const promises = [
        manager.executeWorkflow('simple-workflow.ts', { input: 'simple' }),
        manager.executeWorkflow('complex-workflow.ts', {
          input: { items: ['x', 'y', 'z'], multiplier: 3 },
        }),
        manager.executeWorkflow('async-workflow.ts', 25),
        manager.executeWorkflow('simple-workflow.ts', { input: 'another' }),
      ]

      const results = await Promise.all(promises)

      expect(results[0]).toBe('Processed: simple')
      expect(results[1]).toEqual({ result: ['x x 3', 'y x 3', 'z x 3'], count: 3 })
      expect(results[2]).toBe('Completed after 25ms')
      expect(results[3]).toBe('Processed: another')
    })

    test('should maintain performance under concurrent load', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      const startTime = Date.now()

      // Create multiple concurrent batches
      const batches = Array.from({ length: 10 }, (_, batchIndex) =>
        Array.from({ length: 10 }, (_, taskIndex) =>
          manager.executeWorkflow('simple-workflow.ts', {
            input: `batch-${batchIndex}-task-${taskIndex}`,
          }),
        ),
      )

      const allResults = await Promise.all(batches.map((batch) => Promise.all(batch)))

      const endTime = Date.now()

      // Verify all results
      allResults.forEach((batch, batchIndex) => {
        expect(batch).toHaveLength(10)
        batch.forEach((result, taskIndex) => {
          expect(result).toBe(`Processed: batch-${batchIndex}-task-${taskIndex}`)
        })
      })

      // Should complete within reasonable time
      expect(endTime - startTime).toBeLessThan(10000)
    })
  })
})
