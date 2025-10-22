import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTemporalClient, WorkerRuntime, WorkflowIsolateManager } from '../src'

// Test configuration
const testWorkflowsDir = join(process.cwd(), '.test-end-to-end-workflows')

// Test workflow definitions
const helloWorkflow = `
export default async function helloWorkflow(input: any) {
  console.log('👋 Hello workflow started')
  console.log('Input:', input)
  
  const { name = 'World', message = 'Hello' } = input
  
  // Simulate some work
  await Bun.sleep(100)
  
  const result = {
    success: true,
    greeting: \`\${message}, \${name}!\`,
    timestamp: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun'
  }
  
  console.log('✅ Hello workflow completed')
  return result
}
`

const activityWorkflow = `
export default async function activityWorkflow(input: any) {
  console.log('⚡ Activity workflow started')
  console.log('Input:', input)
  
  const { task = 'default task' } = input
  
  // Simulate activity execution
  await Bun.sleep(50)
  
  const result = {
    success: true,
    task: \`Completed: \${task}\`,
    processedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun'
  }
  
  console.log('✅ Activity workflow completed')
  return result
}
`

const errorWorkflow = `
export default async function errorWorkflow(input: any) {
  console.log('❌ Error workflow started')
  console.log('Input:', input)
  
  const { shouldThrow = false } = input
  
  if (shouldThrow) {
    throw new Error('Intentional error for testing')
  }
  
  return {
    success: true,
    message: 'No error occurred',
    bunVersion: Bun.version,
    runtime: 'bun'
  }
}
`

describe('End-to-End Integration Tests', () => {
  beforeAll(async () => {
    // Setup test workflows directory
    try {
      rmSync(testWorkflowsDir, { recursive: true, force: true })
    } catch {}
    mkdirSync(testWorkflowsDir, { recursive: true })

    // Write test workflow files
    writeFileSync(join(testWorkflowsDir, 'hello-workflow.ts'), helloWorkflow)
    writeFileSync(join(testWorkflowsDir, 'activity-workflow.ts'), activityWorkflow)
    writeFileSync(join(testWorkflowsDir, 'error-workflow.ts'), errorWorkflow)
  })

  afterAll(async () => {
    // Cleanup test workflows directory
    try {
      rmSync(testWorkflowsDir, { recursive: true, force: true })
    } catch {}
  })

  describe('Client Integration', () => {
    test('should create Temporal client', async () => {
      const { client } = await createTemporalClient({
        address: 'http://127.0.0.1:7233',
        namespace: 'default',
      })

      expect(client).toBeDefined()
      expect(typeof client.describeNamespace).toBe('function')
      expect(typeof client.startWorkflow).toBe('function')
      expect(typeof client.close).toBe('function')
    })

    test('should describe namespace', async () => {
      const { client } = await createTemporalClient({
        address: 'http://127.0.0.1:7233',
        namespace: 'default',
      })

      const namespace = await client.describeNamespace('default')
      expect(namespace).toBeDefined()
      expect(namespace.name).toBe('default')
    })

    test('should start workflow', async () => {
      const { client } = await createTemporalClient({
        address: 'http://127.0.0.1:7233',
        namespace: 'default',
      })

      const handle = await client.startWorkflow({
        workflowId: 'test-workflow-001',
        workflowType: 'hello-workflow',
        taskQueue: 'test-queue',
        args: [{ name: 'Test User', message: 'Hello from test!' }],
      })

      expect(handle).toBeDefined()
      expect(handle.workflowId).toBe('test-workflow-001')
      expect(handle.runId).toBeDefined()
      expect(handle.namespace).toBe('default')
    })
  })

  describe('Workflow Execution', () => {
    test('should execute hello workflow', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('hello-workflow.ts', {
        name: 'Integration Test',
        message: 'Hello from integration test!',
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.greeting).toBe('Hello from integration test!, Integration Test!')
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')
    })

    test('should execute activity workflow', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('activity-workflow.ts', {
        task: 'integration test task',
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.task).toBe('Completed: integration test task')
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')
    })

    test('should handle workflow errors', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      try {
        await manager.executeWorkflow('error-workflow.ts', {
          shouldThrow: true,
        })
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeDefined()
        expect(error.message).toContain('Intentional error for testing')
      }
    })

    test('should handle successful error workflow', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('error-workflow.ts', {
        shouldThrow: false,
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.message).toBe('No error occurred')
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')
    })
  })

  describe('Worker Runtime Integration', () => {
    test('should create worker runtime', async () => {
      const worker = await WorkerRuntime.create({
        workflowsPath: testWorkflowsDir,
        activities: {
          'test-activity': async (input: unknown) => {
            await Bun.sleep(10)
            return { success: true, input, processedAt: new Date().toISOString() }
          },
        },
        taskQueue: 'test-queue',
        namespace: 'default',
      })

      expect(worker).toBeDefined()
      expect(typeof worker.run).toBe('function')
      expect(typeof worker.shutdown).toBe('function')
    })

    test('should handle worker lifecycle', async () => {
      const worker = await WorkerRuntime.create({
        workflowsPath: testWorkflowsDir,
        activities: {
          'test-activity': async (input: unknown) => {
            return { success: true, input }
          },
        },
        taskQueue: 'test-queue',
        namespace: 'default',
      })

      // Start worker in background with timeout
      const runPromise = worker.run()

      // Give it a moment to start
      await Bun.sleep(100)

      // Shutdown worker
      await worker.shutdown()

      // The run promise should resolve (or reject) after shutdown
      try {
        await Promise.race([
          runPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1000)),
        ])
      } catch (error) {
        // Expected to throw when shutdown or timeout
        expect(error).toBeDefined()
      }
    }, 10000) // 10 second timeout
  })

  describe('Workflow Caching', () => {
    test('should cache workflows efficiently', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // Load workflow first time
      const startTime1 = Date.now()
      await manager.loadWorkflow('hello-workflow.ts')
      const endTime1 = Date.now()

      // Load workflow second time (should use cache)
      const startTime2 = Date.now()
      await manager.loadWorkflow('hello-workflow.ts')
      const endTime2 = Date.now()

      // Second load should be faster or equal (cached)
      expect(endTime2 - startTime2).toBeLessThanOrEqual(endTime1 - startTime1)

      // Verify cache is working
      expect(manager.isolates.size).toBe(1)
    })

    test('should handle multiple workflow types', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // Load multiple workflow types
      await manager.loadWorkflow('hello-workflow.ts')
      await manager.loadWorkflow('activity-workflow.ts')
      await manager.loadWorkflow('error-workflow.ts')

      // Verify all workflows are cached
      expect(manager.isolates.size).toBe(3)

      // Execute each workflow
      const results = await Promise.all([
        manager.executeWorkflow('hello-workflow.ts', { name: 'Test 1' }),
        manager.executeWorkflow('activity-workflow.ts', { task: 'Test 2' }),
        manager.executeWorkflow('error-workflow.ts', { shouldThrow: false }),
      ])

      // Verify all workflows executed successfully
      results.forEach((result, _index) => {
        expect(result).toBeDefined()
        expect(result.success).toBe(true)
        expect(result.runtime).toBe('bun')
        expect(result.bunVersion).toBeDefined()
      })
    })
  })

  describe('Performance Tests', () => {
    test('should handle concurrent workflow execution', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = Date.now()
      const promises = Array.from({ length: 10 }, (_, i) =>
        manager.executeWorkflow('hello-workflow.ts', {
          name: `User ${i}`,
          message: `Hello ${i}`,
        }),
      )

      const results = await Promise.all(promises)
      const endTime = Date.now()

      const totalDuration = endTime - startTime

      expect(results).toHaveLength(10)
      results.forEach((result, index) => {
        expect(result.success).toBe(true)
        expect(result.greeting).toBe(`Hello ${index}, User ${index}!`)
        expect(result.runtime).toBe('bun')
      })

      // Should complete reasonably quickly
      expect(totalDuration).toBeLessThan(2000) // 2 seconds for 10 workflows
    })

    test('should handle mixed workflow types efficiently', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = Date.now()
      const promises = [
        manager.executeWorkflow('hello-workflow.ts', { name: 'User 1', message: 'Hello 1' }),
        manager.executeWorkflow('activity-workflow.ts', { task: 'Task 1' }),
        manager.executeWorkflow('error-workflow.ts', { shouldThrow: false }),
        manager.executeWorkflow('hello-workflow.ts', { name: 'User 2', message: 'Hello 2' }),
        manager.executeWorkflow('activity-workflow.ts', { task: 'Task 2' }),
      ]

      const results = await Promise.all(promises)
      const endTime = Date.now()

      const totalDuration = endTime - startTime

      expect(results).toHaveLength(5)
      results.forEach((result) => {
        expect(result.success).toBe(true)
        expect(result.runtime).toBe('bun')
        expect(result.bunVersion).toBeDefined()
      })

      // Should complete reasonably quickly
      expect(totalDuration).toBeLessThan(1000) // 1 second for mixed workload
    })
  })

  describe('Error Handling', () => {
    test('should handle malformed workflow files', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      try {
        await manager.executeWorkflow('nonexistent-workflow.ts', { test: 'data' })
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeDefined()
        expect(error.message).toContain('Cannot find module')
      }
    })

    test('should handle workflow execution errors gracefully', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      try {
        await manager.executeWorkflow('error-workflow.ts', { shouldThrow: true })
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeDefined()
        expect(error.message).toContain('Intentional error for testing')
      }
    })

    test('should cleanup resources properly', async () => {
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // Load and execute workflow
      await manager.executeWorkflow('hello-workflow.ts', { name: 'Test' })

      // Clear cache
      manager.clearCache()

      // Verify cache is cleared
      expect(manager.isolates.size).toBe(0)
    })
  })
})
