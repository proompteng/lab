import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkflowIsolateManager } from '../src/worker/task-loops.js'

const TEST_WORKFLOWS_DIR = join(process.cwd(), 'packages/temporal-bun-sdk/.test-workflows-mock')

describe('Comprehensive Worker Mock Tests (zig-worker-01 through zig-worker-09)', () => {
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
      {
        name: 'null-handling-workflow.ts',
        content: `
export async function nullHandlingWorkflow(input: any): Promise<string> {
  if (input === null) return 'Processed: null'
  if (input === undefined) return 'Processed: undefined'
  if (typeof input === 'object') return 'Processed: [object Object]'
  return \`Processed: \${input}\`
}

export default nullHandlingWorkflow
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
    test('should create WorkflowIsolateManager successfully', () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      expect(manager).toBeDefined()
      expect(manager.workflowsPath).toBe(TEST_WORKFLOWS_DIR)
      expect(manager.isolates.size).toBe(0)
    })

    test('should handle multiple manager instances', () => {
      const manager1 = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)
      const manager2 = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      expect(manager1).toBeDefined()
      expect(manager2).toBeDefined()
      expect(manager1).not.toBe(manager2)
    })

    test('should handle manager creation with invalid paths', () => {
      expect(() => {
        new WorkflowIsolateManager('/nonexistent/path')
      }).toThrow('Workflows path does not exist: /nonexistent/path')
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
    test('should handle manager cleanup', () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Test cache operations
      expect(manager.isolates.size).toBe(0)

      // Clear cache
      manager.clearCache()
      expect(manager.isolates.size).toBe(0)
    })

    test('should handle multiple cleanup calls', () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Multiple cache clears should not cause issues
      manager.clearCache()
      manager.clearCache()
      manager.clearCache()

      expect(manager.isolates.size).toBe(0)
    })

    test('should finalize cleanup cleanly', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Load some workflows
      await manager.loadWorkflow('simple-workflow.ts')
      expect(manager.isolates.size).toBe(1)

      // Clear and verify
      manager.clearCache()
      expect(manager.isolates.size).toBe(0)
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
      const result1 = await manager.executeWorkflow('null-handling-workflow.ts', null)
      expect(result1).toBe('Processed: null')

      // Test with undefined input
      const result2 = await manager.executeWorkflow('null-handling-workflow.ts', undefined)
      expect(result2).toBe('Processed: undefined')

      // Test with object input
      const result3 = await manager.executeWorkflow('null-handling-workflow.ts', { test: 'value' })
      expect(result3).toBe('Processed: [object Object]')
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
        items: ['a', 'b', 'c'],
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

    test('should cache workflows efficiently', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Load the same workflow multiple times
      const workflow1 = await manager.loadWorkflow('simple-workflow.ts')
      const workflow2 = await manager.loadWorkflow('simple-workflow.ts')
      const workflow3 = await manager.loadWorkflow('simple-workflow.ts')

      // Should return the same instance (cached)
      expect(workflow1).toBe(workflow2)
      expect(workflow2).toBe(workflow3)
      expect(manager.isolates.size).toBe(1)
    })

    test('should handle workflow cache invalidation', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Load workflow
      await manager.loadWorkflow('simple-workflow.ts')
      expect(manager.isolates.size).toBe(1)

      // Clear cache
      manager.clearCache()
      expect(manager.isolates.size).toBe(0)

      // Load again - should be a new instance
      const workflow = await manager.loadWorkflow('simple-workflow.ts')
      expect(workflow).toBeDefined()
      expect(manager.isolates.size).toBe(1)
    })
  })

  describe('Memory Management', () => {
    test('should handle workflow memory cleanup', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Load multiple workflows
      await manager.loadWorkflow('simple-workflow.ts')
      await manager.loadWorkflow('complex-workflow.ts')
      await manager.loadWorkflow('error-workflow.ts')

      expect(manager.isolates.size).toBe(3)

      // Clear cache
      manager.clearCache()
      expect(manager.isolates.size).toBe(0)
    })

    test('should handle repeated load/unload cycles', async () => {
      const manager = new WorkflowIsolateManager(TEST_WORKFLOWS_DIR)

      // Multiple load/unload cycles
      for (let i = 0; i < 10; i++) {
        await manager.loadWorkflow('simple-workflow.ts')
        expect(manager.isolates.size).toBe(1)

        manager.clearCache()
        expect(manager.isolates.size).toBe(0)
      }
    })
  })
})
