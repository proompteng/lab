import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTemporalServerAvailable } from './helpers/temporal-server'

// Test configuration
const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
const shouldRun = process.env.TEMPORAL_TEST_SERVER === '1'
const serverAvailable = shouldRun ? await isTemporalServerAvailable(temporalAddress) : false

// Test workflows directory
const testWorkflowsDir = join(process.cwd(), '.test-bun-performance-workflows')

// Performance benchmark workflow definitions
const bunPerformanceWorkflow = `
export default async function bunPerformanceWorkflow(input: any) {
  const startTime = performance.now()
  
  // Test different performance characteristics
  const operations = input.operations || 1000
  const testType = input.testType || 'math'
  
  let result
  
  switch (testType) {
    case 'math':
      result = await performMathOperations(operations)
      break
    case 'string':
      result = await performStringOperations(operations)
      break
    case 'array':
      result = await performArrayOperations(operations)
      break
    case 'object':
      result = await performObjectOperations(operations)
      break
    case 'async':
      result = await performAsyncOperations(operations)
      break
    default:
      result = await performMathOperations(operations)
  }
  
  const endTime = performance.now()
  const duration = endTime - startTime
  
  return {
    success: true,
    testType,
    operations,
    result,
    duration,
    operationsPerSecond: operations / (duration / 1000),
    bunVersion: Bun.version,
    runtime: 'bun',
    memoryUsage: process.memoryUsage()
  }
}

async function performMathOperations(count: number) {
  let sum = 0
  for (let i = 0; i < count; i++) {
    sum += Math.sqrt(i) * Math.sin(i) + Math.cos(i)
  }
  return { sum, type: 'math' }
}

async function performStringOperations(count: number) {
  let result = ''
  for (let i = 0; i < count; i++) {
    result += \`item-\${i}-\${Math.random()}\`
  }
  return { length: result.length, type: 'string' }
}

async function performArrayOperations(count: number) {
  const array = []
  for (let i = 0; i < count; i++) {
    array.push({ id: i, value: Math.random(), timestamp: Date.now() })
  }
  return { length: array.length, type: 'array' }
}

async function performObjectOperations(count: number) {
  const obj = {}
  for (let i = 0; i < count; i++) {
    obj[\`key-\${i}\`] = { value: Math.random(), timestamp: Date.now() }
  }
  return { keys: Object.keys(obj).length, type: 'object' }
}

async function performAsyncOperations(count: number) {
  const promises = []
  for (let i = 0; i < count; i++) {
    promises.push(
      (async () => {
        await Bun.sleep(0) // Minimal async operation
        return { id: i, value: Math.random() }
      })()
    )
  }
  const results = await Promise.all(promises)
  return { count: results.length, type: 'async' }
}
`

const bunConcurrencyBenchmarkWorkflow = `
export default async function bunConcurrencyBenchmarkWorkflow(input: any) {
  const startTime = performance.now()
  
  const concurrentTasks = input.concurrentTasks || 10
  const operationsPerTask = input.operationsPerTask || 100
  
  // Create concurrent tasks
  const tasks = Array.from({ length: concurrentTasks }, (_, i) => 
    performConcurrentTask(i, operationsPerTask)
  )
  
  // Execute all tasks concurrently
  const results = await Promise.all(tasks)
  
  const endTime = performance.now()
  const duration = endTime - startTime
  
  return {
    success: true,
    concurrentTasks,
    operationsPerTask,
    totalOperations: concurrentTasks * operationsPerTask,
    results,
    duration,
    operationsPerSecond: (concurrentTasks * operationsPerTask) / (duration / 1000),
    bunVersion: Bun.version,
    runtime: 'bun',
    memoryUsage: process.memoryUsage()
  }
}

async function performConcurrentTask(taskId: number, operations: number) {
  const startTime = performance.now()
  let sum = 0
  
  for (let i = 0; i < operations; i++) {
    sum += Math.sqrt(i + taskId) * Math.sin(i) + Math.cos(i)
  }
  
  const endTime = performance.now()
  const duration = endTime - startTime
  
  return {
    taskId,
    operations,
    sum,
    duration,
    operationsPerSecond: operations / (duration / 1000)
  }
}
`

const bunMemoryBenchmarkWorkflow = `
export default async function bunMemoryBenchmarkWorkflow(input: any) {
  const initialMemory = process.memoryUsage()
  
  const iterations = input.iterations || 1000
  const dataSize = input.dataSize || 1024
  
  const data = []
  
  for (let i = 0; i < iterations; i++) {
    // Create data of specified size
    const item = {
      id: i,
      data: new Array(dataSize).fill(Math.random()),
      timestamp: Date.now(),
      buffer: new ArrayBuffer(dataSize)
    }
    data.push(item)
  }
  
  const peakMemory = process.memoryUsage()
  
  // Clear data to test garbage collection
  data.length = 0
  
  // Force garbage collection if available
  if (typeof global.gc === 'function') {
    global.gc()
  }
  
  const finalMemory = process.memoryUsage()
  
  return {
    success: true,
    iterations,
    dataSize,
    totalDataSize: iterations * dataSize,
    memoryUsage: {
      initial: initialMemory,
      peak: peakMemory,
      final: finalMemory,
      peakIncrease: peakMemory.heapUsed - initialMemory.heapUsed,
      finalIncrease: finalMemory.heapUsed - initialMemory.heapUsed
    },
    bunVersion: Bun.version,
    runtime: 'bun'
  }
}
`

describe('Bun Performance Benchmark Tests', () => {
  let _native: typeof import('../src/internal/core-bridge/native.js').native | undefined
  let _createTemporalClient: typeof import('../src/client.js').createTemporalClient | undefined
  let _NativeBridgeError: typeof import('../src/internal/core-bridge/native.js').NativeBridgeError | undefined

  beforeAll(async () => {
    if (!serverAvailable) {
      console.warn(`Skipping Bun performance benchmark tests: Temporal server unavailable at ${temporalAddress}`)
      return
    }

    // Setup test workflows directory
    try {
      rmSync(testWorkflowsDir, { recursive: true, force: true })
    } catch {}
    mkdirSync(testWorkflowsDir, { recursive: true })

    // Write performance benchmark workflow files
    writeFileSync(join(testWorkflowsDir, 'bun-performance-workflow.ts'), bunPerformanceWorkflow)
    writeFileSync(join(testWorkflowsDir, 'bun-concurrency-benchmark-workflow.ts'), bunConcurrencyBenchmarkWorkflow)
    writeFileSync(join(testWorkflowsDir, 'bun-memory-benchmark-workflow.ts'), bunMemoryBenchmarkWorkflow)

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

  describe('Bun Math Performance', () => {
    test('should handle high-performance math operations', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-performance-workflow.ts', {
        operations: 10000,
        testType: 'math',
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.testType).toBe('math')
      expect(result.operations).toBe(10000)
      expect(result.operationsPerSecond).toBeGreaterThan(1000) // Bun should be fast
      expect(result.runtime).toBe('bun')
      expect(result.bunVersion).toBeDefined()
    })

    test('should handle string operations efficiently', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-performance-workflow.ts', {
        operations: 5000,
        testType: 'string',
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.testType).toBe('string')
      expect(result.operations).toBe(5000)
      expect(result.operationsPerSecond).toBeGreaterThan(500) // String ops are slower
      expect(result.runtime).toBe('bun')
    })

    test('should handle array operations efficiently', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-performance-workflow.ts', {
        operations: 2000,
        testType: 'array',
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.testType).toBe('array')
      expect(result.operations).toBe(2000)
      expect(result.operationsPerSecond).toBeGreaterThan(100) // Array ops are slower
      expect(result.runtime).toBe('bun')
    })

    test('should handle object operations efficiently', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-performance-workflow.ts', {
        operations: 1000,
        testType: 'object',
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.testType).toBe('object')
      expect(result.operations).toBe(1000)
      expect(result.operationsPerSecond).toBeGreaterThan(50) // Object ops are slower
      expect(result.runtime).toBe('bun')
    })

    test('should handle async operations efficiently', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-performance-workflow.ts', {
        operations: 500,
        testType: 'async',
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.testType).toBe('async')
      expect(result.operations).toBe(500)
      expect(result.operationsPerSecond).toBeGreaterThan(100) // Async ops are slower
      expect(result.runtime).toBe('bun')
    })
  })

  describe('Bun Concurrency Performance', () => {
    test('should handle high concurrency efficiently', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-concurrency-benchmark-workflow.ts', {
        concurrentTasks: 20,
        operationsPerTask: 100,
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.concurrentTasks).toBe(20)
      expect(result.operationsPerTask).toBe(100)
      expect(result.totalOperations).toBe(2000)
      expect(result.operationsPerSecond).toBeGreaterThan(500) // Bun should handle concurrency well
      expect(result.runtime).toBe('bun')
    })

    test('should scale with increasing concurrency', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const concurrencyLevels = [5, 10, 20, 50]
      const results = []

      for (const level of concurrencyLevels) {
        const result = await manager.executeWorkflow('bun-concurrency-benchmark-workflow.ts', {
          concurrentTasks: level,
          operationsPerTask: 50,
        })
        results.push({
          concurrency: level,
          operationsPerSecond: result.operationsPerSecond,
          duration: result.duration,
        })
      }

      // Verify performance scales reasonably
      expect(results).toHaveLength(4)
      results.forEach((result) => {
        expect(result.operationsPerSecond).toBeGreaterThan(100)
        expect(result.duration).toBeLessThan(5000) // Should complete within 5 seconds
      })
    })
  })

  describe('Bun Memory Performance', () => {
    test('should handle memory allocation efficiently', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-memory-benchmark-workflow.ts', {
        iterations: 1000,
        dataSize: 512,
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.iterations).toBe(1000)
      expect(result.dataSize).toBe(512)
      expect(result.totalDataSize).toBe(512000)
      expect(result.memoryUsage).toBeDefined()
      expect(result.memoryUsage.peakIncrease).toBeGreaterThanOrEqual(0)
      expect(result.runtime).toBe('bun')
    })

    test('should handle garbage collection efficiently', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-memory-benchmark-workflow.ts', {
        iterations: 500,
        dataSize: 1024,
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.memoryUsage).toBeDefined()
      expect(result.memoryUsage.finalIncrease).toBeLessThanOrEqual(result.memoryUsage.peakIncrease)
      expect(result.runtime).toBe('bun')
    })
  })

  describe('Bun Workflow Performance', () => {
    test('should execute workflows with minimal overhead', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = performance.now()
      const result = await manager.executeWorkflow('bun-performance-workflow.ts', {
        operations: 1000,
        testType: 'math',
      })
      const endTime = performance.now()

      const totalDuration = endTime - startTime
      const workflowDuration = result.duration
      const overhead = totalDuration - workflowDuration

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(overhead).toBeLessThan(100) // Overhead should be minimal
      expect(result.runtime).toBe('bun')
    })

    test('should cache workflows for performance', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // First execution
      const startTime1 = performance.now()
      await manager.executeWorkflow('bun-performance-workflow.ts', { operations: 100 })
      const endTime1 = performance.now()

      // Second execution (should use cache)
      const startTime2 = performance.now()
      await manager.executeWorkflow('bun-performance-workflow.ts', { operations: 100 })
      const endTime2 = performance.now()

      const firstDuration = endTime1 - startTime1
      const secondDuration = endTime2 - startTime2

      // Second execution should be faster due to caching
      expect(secondDuration).toBeLessThanOrEqual(firstDuration)
      expect(manager.isolates.size).toBe(1) // Should be cached
    })
  })

  describe('Bun Runtime Performance', () => {
    test('should maintain performance under load', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = performance.now()
      const promises = Array.from({ length: 10 }, (_, _i) =>
        manager.executeWorkflow('bun-performance-workflow.ts', {
          operations: 500,
          testType: 'math',
        }),
      )

      const results = await Promise.all(promises)
      const endTime = performance.now()

      const totalDuration = endTime - startTime

      expect(results).toHaveLength(10)
      results.forEach((result) => {
        expect(result.success).toBe(true)
        expect(result.runtime).toBe('bun')
        expect(result.operationsPerSecond).toBeGreaterThan(500)
      })

      // Should complete reasonably quickly
      expect(totalDuration).toBeLessThan(2000) // 2 seconds for 10 workflows
    })

    test('should handle mixed workload efficiently', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = performance.now()
      const promises = [
        manager.executeWorkflow('bun-performance-workflow.ts', { operations: 1000, testType: 'math' }),
        manager.executeWorkflow('bun-performance-workflow.ts', { operations: 500, testType: 'string' }),
        manager.executeWorkflow('bun-performance-workflow.ts', { operations: 200, testType: 'array' }),
        manager.executeWorkflow('bun-performance-workflow.ts', { operations: 100, testType: 'object' }),
        manager.executeWorkflow('bun-performance-workflow.ts', { operations: 50, testType: 'async' }),
      ]

      const results = await Promise.all(promises)
      const endTime = performance.now()

      const totalDuration = endTime - startTime

      expect(results).toHaveLength(5)
      results.forEach((result) => {
        expect(result.success).toBe(true)
        expect(result.runtime).toBe('bun')
      })

      // Should complete reasonably quickly
      expect(totalDuration).toBeLessThan(1000) // 1 second for mixed workload
    })
  })
})
