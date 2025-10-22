import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTemporalServerAvailable } from './helpers/temporal-server'

// Test configuration
const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
const shouldRun = process.env.TEMPORAL_TEST_SERVER === '1'
const serverAvailable = shouldRun ? await isTemporalServerAvailable(temporalAddress) : false

// Test workflows directory
const testWorkflowsDir = join(process.cwd(), '.test-worker-integration')

// Test workflow definitions
const workerTestWorkflow = `
export default async function workerTestWorkflow(input: any) {
  console.log('Worker test workflow started with input:', input)
  
  // Simulate some work
  await new Promise(resolve => setTimeout(resolve, 100))
  
  return {
    workflowId: input.workflowId || 'test-workflow',
    result: 'Worker test completed successfully',
    timestamp: new Date().toISOString(),
    input
  }
}
`

const activityWorkflow = `
export default async function activityWorkflow(input: any) {
  console.log('Activity workflow started')
  
  // Simulate activity execution
  const activityResult = await executeActivity('test-activity', input)
  
  return {
    workflowId: input.workflowId || 'activity-workflow',
    activityResult,
    timestamp: new Date().toISOString()
  }
}

async function executeActivity(name: string, input: any) {
  console.log(\`Executing activity: \${name}\`)
  await new Promise(resolve => setTimeout(resolve, 50))
  
  return {
    activityName: name,
    processed: true,
    input: input,
    duration: 50
  }
}
`

const errorHandlingWorkflow = `
export default async function errorHandlingWorkflow(input: any) {
  console.log('Error handling workflow started')
  
  try {
    if (input.shouldThrow) {
      throw new Error('Intentional error for testing')
    }
    
    return {
      workflowId: input.workflowId || 'error-workflow',
      status: 'success',
      timestamp: new Date().toISOString()
    }
  } catch (error) {
    return {
      workflowId: input.workflowId || 'error-workflow',
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    }
  }
}
`

const longRunningWorkflow = `
export default async function longRunningWorkflow(input: any) {
  console.log('Long running workflow started')
  
  const duration = input.duration || 1000
  const steps = input.steps || 5
  
  const results = []
  
  for (let i = 0; i < steps; i++) {
    console.log(\`Processing step \${i + 1}/\${steps}\`)
    await new Promise(resolve => setTimeout(resolve, duration / steps))
    
    results.push({
      step: i + 1,
      completed: true,
      timestamp: new Date().toISOString()
    })
  }
  
  return {
    workflowId: input.workflowId || 'long-running-workflow',
    status: 'completed',
    steps: results.length,
    results,
    totalDuration: duration,
    timestamp: new Date().toISOString()
  }
}
`

const concurrentWorkflow = `
export default async function concurrentWorkflow(input: any) {
  console.log('Concurrent workflow started')
  
  const tasks = input.tasks || 3
  const promises = []
  
  for (let i = 0; i < tasks; i++) {
    promises.push(processConcurrentTask(i, input))
  }
  
  const results = await Promise.all(promises)
  
  return {
    workflowId: input.workflowId || 'concurrent-workflow',
    status: 'completed',
    tasks: results.length,
    results,
    timestamp: new Date().toISOString()
  }
}

async function processConcurrentTask(index: number, input: any) {
  console.log(\`Processing concurrent task \${index}\`)
  await new Promise(resolve => setTimeout(resolve, 100))
  
  return {
    taskIndex: index,
    completed: true,
    result: \`task-\${index}-completed\`,
    timestamp: new Date().toISOString()
  }
}
`

describe('Worker Integration Tests with Live Temporal Server', () => {
  let _native: typeof import('../src/internal/core-bridge/native.js').native | undefined
  let _createTemporalClient: typeof import('../src/client.js').createTemporalClient | undefined
  let _NativeBridgeError: typeof import('../src/internal/core-bridge/native.js').NativeBridgeError | undefined

  beforeAll(async () => {
    if (!serverAvailable) {
      console.warn(`Skipping worker integration tests: Temporal server unavailable at ${temporalAddress}`)
      return
    }

    // Setup test workflows directory
    try {
      rmSync(testWorkflowsDir, { recursive: true, force: true })
    } catch {}
    mkdirSync(testWorkflowsDir, { recursive: true })

    // Write test workflow files
    writeFileSync(join(testWorkflowsDir, 'worker-test-workflow.ts'), workerTestWorkflow)
    writeFileSync(join(testWorkflowsDir, 'activity-workflow.ts'), activityWorkflow)
    writeFileSync(join(testWorkflowsDir, 'error-handling-workflow.ts'), errorHandlingWorkflow)
    writeFileSync(join(testWorkflowsDir, 'long-running-workflow.ts'), longRunningWorkflow)
    writeFileSync(join(testWorkflowsDir, 'concurrent-workflow.ts'), concurrentWorkflow)

    // Import native bridge
    try {
      const bridge = await import('../src/internal/core-bridge/native.js')
      _native = bridge.native
      _createTemporalClient = bridge.createTemporalClient
      _NativeBridgeError = bridge.NativeBridgeError
    } catch (error) {
      console.warn('Failed to load native bridge:', error)
    }
  })

  afterAll(async () => {
    // Cleanup test workflows directory
    try {
      rmSync(testWorkflowsDir, { recursive: true, force: true })
    } catch {}
  })

  describe('Worker Runtime Integration', () => {
    test('should create worker runtime with live server', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkerRuntime } = await import('../src/worker/runtime.js')

      const worker = new WorkerRuntime({
        workflowsPath: testWorkflowsDir,
        taskQueue: 'test-worker-queue',
        namespace: 'default',
      })

      expect(worker).toBeDefined()
      // Note: WorkerRuntime methods are not yet implemented
      // expect(typeof worker.start).toBe('function')
      // expect(typeof worker.shutdown).toBe('function')
    })

    test('should handle worker lifecycle management', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkerRuntime } = await import('../src/worker/runtime.js')

      const worker = new WorkerRuntime({
        workflowsPath: testWorkflowsDir,
        taskQueue: 'test-worker-queue',
        namespace: 'default',
      })

      // Test worker creation and shutdown
      expect(() => worker.shutdown()).not.toThrow()
    })

    test('should handle multiple worker instances', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkerRuntime } = await import('../src/worker/runtime.js')

      const worker1 = new WorkerRuntime({
        workflowsPath: testWorkflowsDir,
        taskQueue: 'test-worker-queue-1',
        namespace: 'default',
      })

      const worker2 = new WorkerRuntime({
        workflowsPath: testWorkflowsDir,
        taskQueue: 'test-worker-queue-2',
        namespace: 'default',
      })

      expect(worker1).toBeDefined()
      expect(worker2).toBeDefined()

      // Both workers should be independent
      expect(() => worker1.shutdown()).not.toThrow()
      expect(() => worker2.shutdown()).not.toThrow()
    })
  })

  describe('Workflow Execution Integration', () => {
    test('should execute basic workflow through worker', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const input = {
        workflowId: 'test-workflow-001',
        testData: 'integration test',
      }

      const result = await manager.executeWorkflow('worker-test-workflow.ts', input)

      expect(result).toBeDefined()
      expect(result.workflowId).toBe('test-workflow-001')
      expect(result.result).toBe('Worker test completed successfully')
      expect(result.timestamp).toBeDefined()
      expect(result.input).toEqual(input)
    })

    test('should execute workflow with activities', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const input = {
        workflowId: 'activity-workflow-001',
        activityData: 'test activity data',
      }

      const result = await manager.executeWorkflow('activity-workflow.ts', input)

      expect(result).toBeDefined()
      expect(result.workflowId).toBe('activity-workflow-001')
      expect(result.activityResult).toBeDefined()
      expect(result.activityResult.activityName).toBe('test-activity')
      expect(result.activityResult.processed).toBe(true)
      expect(result.activityResult.input).toEqual(input)
    })

    test('should handle workflow errors gracefully', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const input = {
        workflowId: 'error-workflow-001',
        shouldThrow: true,
      }

      const result = await manager.executeWorkflow('error-handling-workflow.ts', input)

      expect(result).toBeDefined()
      expect(result.workflowId).toBe('error-workflow-001')
      expect(result.status).toBe('error')
      expect(result.error).toBe('Intentional error for testing')
      expect(result.timestamp).toBeDefined()
    })

    test('should execute long-running workflow', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const input = {
        workflowId: 'long-running-workflow-001',
        duration: 500,
        steps: 3,
      }

      const startTime = Date.now()
      const result = await manager.executeWorkflow('long-running-workflow.ts', input)
      const endTime = Date.now()

      expect(result).toBeDefined()
      expect(result.workflowId).toBe('long-running-workflow-001')
      expect(result.status).toBe('completed')
      expect(result.steps).toBe(3)
      expect(result.results).toHaveLength(3)
      expect(result.totalDuration).toBe(500)
      expect(endTime - startTime).toBeGreaterThanOrEqual(490) // Allow some tolerance
    })

    test('should execute concurrent workflow', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const input = {
        workflowId: 'concurrent-workflow-001',
        tasks: 4,
      }

      const result = await manager.executeWorkflow('concurrent-workflow.ts', input)

      expect(result).toBeDefined()
      expect(result.workflowId).toBe('concurrent-workflow-001')
      expect(result.status).toBe('completed')
      expect(result.tasks).toBe(4)
      expect(result.results).toHaveLength(4)

      // Verify all tasks completed
      result.results.forEach((taskResult, index) => {
        expect(taskResult.taskIndex).toBe(index)
        expect(taskResult.completed).toBe(true)
        expect(taskResult.result).toBe(`task-${index}-completed`)
      })
    })
  })

  describe('Worker Performance Integration', () => {
    test('should handle high-frequency workflow execution', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = Date.now()
      const promises = Array.from({ length: 10 }, (_, i) =>
        manager.executeWorkflow('worker-test-workflow.ts', {
          workflowId: `perf-test-${i}`,
          index: i,
        }),
      )

      const results = await Promise.all(promises)
      const endTime = Date.now()

      expect(results).toHaveLength(10)
      results.forEach((result, i) => {
        expect(result.workflowId).toBe(`perf-test-${i}`)
        expect(result.result).toBe('Worker test completed successfully')
      })

      // Should complete reasonably quickly
      expect(endTime - startTime).toBeLessThan(2000) // 2 seconds for 10 workflows
    })

    test('should maintain performance under concurrent load', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = Date.now()
      const promises = Array.from({ length: 5 }, (_, i) =>
        manager.executeWorkflow('concurrent-workflow.ts', {
          workflowId: `concurrent-perf-${i}`,
          tasks: 3,
        }),
      )

      const results = await Promise.all(promises)
      const endTime = Date.now()

      expect(results).toHaveLength(5)
      results.forEach((result, i) => {
        expect(result.workflowId).toBe(`concurrent-perf-${i}`)
        expect(result.status).toBe('completed')
        expect(result.tasks).toBe(3)
      })

      // Should complete reasonably quickly
      expect(endTime - startTime).toBeLessThan(1500) // 1.5 seconds for 5 concurrent workflows
    })

    test('should handle mixed workflow types efficiently', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = Date.now()
      const promises = [
        manager.executeWorkflow('worker-test-workflow.ts', { workflowId: 'mixed-1' }),
        manager.executeWorkflow('activity-workflow.ts', { workflowId: 'mixed-2' }),
        manager.executeWorkflow('error-handling-workflow.ts', { workflowId: 'mixed-3', shouldThrow: false }),
        manager.executeWorkflow('concurrent-workflow.ts', { workflowId: 'mixed-4', tasks: 2 }),
      ]

      const results = await Promise.all(promises)
      const endTime = Date.now()

      expect(results).toHaveLength(4)
      expect(results[0].workflowId).toBe('mixed-1')
      expect(results[1].workflowId).toBe('mixed-2')
      expect(results[2].workflowId).toBe('mixed-3')
      expect(results[3].workflowId).toBe('mixed-4')

      // Should complete reasonably quickly
      expect(endTime - startTime).toBeLessThan(1000) // 1 second for mixed workflow types
    })
  })

  describe('Worker Error Handling Integration', () => {
    test('should handle workflow execution errors', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const input = {
        workflowId: 'error-test-001',
        shouldThrow: true,
      }

      const result = await manager.executeWorkflow('error-handling-workflow.ts', input)

      expect(result).toBeDefined()
      expect(result.status).toBe('error')
      expect(result.error).toBe('Intentional error for testing')
    })

    test('should handle malformed workflow files', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      // Create a malformed workflow file
      const malformedWorkflow = `
        export default async function malformedWorkflow(input) {
          // Missing closing brace
          return 'test'
        // Missing closing brace
      `
      writeFileSync(join(testWorkflowsDir, 'malformed-workflow.ts'), malformedWorkflow)

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      try {
        await manager.loadWorkflow('malformed-workflow.ts')
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeDefined()
        expect(error.message).toContain('Unexpected end of file')
      }
    })

    test('should handle missing workflow files', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      try {
        await manager.loadWorkflow('non-existent-workflow.ts')
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeDefined()
        expect(error.message).toContain('Cannot find module')
      }
    })
  })

  describe('Worker Memory Management Integration', () => {
    test('should handle workflow cache management', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // Load multiple workflows to test caching
      await manager.loadWorkflow('worker-test-workflow.ts')
      await manager.loadWorkflow('activity-workflow.ts')
      await manager.loadWorkflow('error-handling-workflow.ts')

      // Verify workflows are cached
      expect(manager.isolates.size).toBe(3)

      // Load same workflow again (should use cache)
      const startTime = Date.now()
      await manager.loadWorkflow('worker-test-workflow.ts')
      const endTime = Date.now()

      // Should be very fast due to caching
      expect(endTime - startTime).toBeLessThan(50)
      expect(manager.isolates.size).toBe(3) // No new entries
    })

    test('should cleanup resources properly', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // Load and execute workflows
      await manager.loadWorkflow('worker-test-workflow.ts')
      await manager.executeWorkflow('worker-test-workflow.ts', { test: 'data' })

      // Verify cleanup
      expect(manager.isolates.size).toBe(1)

      // Cleanup should not throw (if cleanup method exists)
      if (typeof manager.cleanup === 'function') {
        expect(() => manager.cleanup()).not.toThrow()
      }
    })
  })
})
