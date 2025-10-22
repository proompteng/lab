import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTemporalServerAvailable } from './helpers/temporal-server'

// Test configuration
const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
const shouldRun = process.env.TEMPORAL_TEST_SERVER === '1'
const serverAvailable = shouldRun ? await isTemporalServerAvailable(temporalAddress) : false

// Test workflows directory
const testWorkflowsDir = join(process.cwd(), '.test-bun-runtime-workflows')

// Bun-specific workflow definitions
const bunAsyncWorkflow = `
export default async function bunAsyncWorkflow(input: any) {
  // Test Bun's async/await handling
  const result = await Bun.sleep(10) // Bun-specific sleep
  return {
    success: true,
    input,
    bunVersion: Bun.version,
    runtime: 'bun',
    timestamp: Date.now()
  }
}
`

const bunSerializationWorkflow = `
export default async function bunSerializationWorkflow(input: any) {
  // Test Bun's serialization capabilities
  const data = {
    string: 'test',
    number: 42,
    boolean: true,
    array: [1, 2, 3],
    object: { nested: 'value' },
    date: new Date().toISOString(), // Convert to string for serialization
    bigint: BigInt(123).toString(), // Convert to string for serialization
    undefined: undefined,
    null: null
  }
  
  // Test Bun's JSON serialization
  const serialized = JSON.stringify(data)
  const deserialized = JSON.parse(serialized)
  
  return {
    success: true,
    original: data,
    serialized,
    deserialized,
    bunVersion: Bun.version,
    runtime: 'bun'
  }
}
`

const bunMemoryWorkflow = `
export default async function bunMemoryWorkflow(input: any) {
  // Test Bun's memory management
  const iterations = input.iterations || 1000
  const results = []
  
  for (let i = 0; i < iterations; i++) {
    const data = {
      id: i,
      value: Math.random(),
      timestamp: Date.now(),
      buffer: new ArrayBuffer(1024) // Test ArrayBuffer handling
    }
    results.push(data)
  }
  
  // Test Bun's garbage collection behavior
  const memoryUsage = process.memoryUsage()
  
  return {
    success: true,
    iterations,
    resultsCount: results.length,
    memoryUsage,
    bunVersion: Bun.version,
    runtime: 'bun'
  }
}
`

const bunErrorHandlingWorkflow = `
export default async function bunErrorHandlingWorkflow(input: any) {
  try {
    if (input.shouldThrow) {
      throw new Error('Bun-specific error')
    }
    
    if (input.shouldThrowAsync) {
      await Bun.sleep(10)
      throw new Error('Bun async error')
    }
    
    return {
      success: true,
      input,
      bunVersion: Bun.version,
      runtime: 'bun'
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stack: error.stack,
      bunVersion: Bun.version,
      runtime: 'bun'
    }
  }
}
`

const bunConcurrencyWorkflow = `
export default async function bunConcurrencyWorkflow(input: any) {
  const tasks = input.tasks || 5
  const promises = []
  
  for (let i = 0; i < tasks; i++) {
    promises.push(
      (async () => {
        await Bun.sleep(10) // Bun-specific sleep
        return {
          taskId: i,
          completed: true,
          timestamp: Date.now()
        }
      })()
    )
  }
  
  const results = await Promise.all(promises)
  
  return {
    success: true,
    tasks,
    results,
    bunVersion: Bun.version,
    runtime: 'bun'
  }
}
`

const bunModuleLoadingWorkflow = `
export default async function bunModuleLoadingWorkflow(input: any) {
  // Test Bun's module loading capabilities
  const fs = await import('node:fs')
  const path = await import('node:path')
  
  // Test dynamic imports
  const crypto = await import('node:crypto')
  
  return {
    success: true,
    input,
    modules: {
      fs: typeof fs,
      path: typeof path,
      crypto: typeof crypto
    },
    bunVersion: Bun.version,
    runtime: 'bun'
  }
}
`

const bunPerformanceWorkflow = `
export default async function bunPerformanceWorkflow(input: any) {
  const startTime = performance.now()
  
  // Test Bun's performance characteristics
  const operations = input.operations || 10000
  let sum = 0
  
  for (let i = 0; i < operations; i++) {
    sum += Math.sqrt(i)
  }
  
  const endTime = performance.now()
  const duration = endTime - startTime
  
  return {
    success: true,
    operations,
    sum,
    duration,
    operationsPerSecond: operations / (duration / 1000),
    bunVersion: Bun.version,
    runtime: 'bun'
  }
}
`

describe('Bun Runtime Compatibility Tests', () => {
  let _native: typeof import('../src/internal/core-bridge/native.js').native | undefined
  let _createTemporalClient: typeof import('../src/client.js').createTemporalClient | undefined
  let _NativeBridgeError: typeof import('../src/internal/core-bridge/native.js').NativeBridgeError | undefined

  beforeAll(async () => {
    if (!serverAvailable) {
      console.warn(`Skipping Bun runtime compatibility tests: Temporal server unavailable at ${temporalAddress}`)
      return
    }

    // Setup test workflows directory
    try {
      rmSync(testWorkflowsDir, { recursive: true, force: true })
    } catch {}
    mkdirSync(testWorkflowsDir, { recursive: true })

    // Write Bun-specific test workflow files
    writeFileSync(join(testWorkflowsDir, 'bun-async-workflow.ts'), bunAsyncWorkflow)
    writeFileSync(join(testWorkflowsDir, 'bun-serialization-workflow.ts'), bunSerializationWorkflow)
    writeFileSync(join(testWorkflowsDir, 'bun-memory-workflow.ts'), bunMemoryWorkflow)
    writeFileSync(join(testWorkflowsDir, 'bun-error-handling-workflow.ts'), bunErrorHandlingWorkflow)
    writeFileSync(join(testWorkflowsDir, 'bun-concurrency-workflow.ts'), bunConcurrencyWorkflow)
    writeFileSync(join(testWorkflowsDir, 'bun-module-loading-workflow.ts'), bunModuleLoadingWorkflow)
    writeFileSync(join(testWorkflowsDir, 'bun-performance-workflow.ts'), bunPerformanceWorkflow)

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

  describe('Bun Async/Await Compatibility', () => {
    test('should handle Bun-specific async operations', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-async-workflow.ts', { test: 'data' })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.input).toEqual({ test: 'data' })
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')
      expect(result.timestamp).toBeDefined()
    })

    test('should handle Bun.sleep() in workflows', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = Date.now()
      const result = await manager.executeWorkflow('bun-async-workflow.ts', { test: 'sleep' })
      const endTime = Date.now()

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(endTime - startTime).toBeGreaterThanOrEqual(8) // Allow some tolerance
    })
  })

  describe('Bun Serialization Compatibility', () => {
    test('should handle Bun serialization capabilities', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-serialization-workflow.ts', { test: 'serialization' })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.original).toBeDefined()
      expect(result.serialized).toBeDefined()
      expect(result.deserialized).toBeDefined()
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')

      // Verify serialization round-trip
      expect(result.deserialized.string).toBe('test')
      expect(result.deserialized.number).toBe(42)
      expect(result.deserialized.boolean).toBe(true)
      expect(result.deserialized.array).toEqual([1, 2, 3])
      expect(result.deserialized.object.nested).toBe('value')
    })

    test('should handle complex data types in Bun', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const complexInput = {
        date: new Date(),
        bigint: BigInt(123),
        undefined: undefined,
        null: null,
        array: [1, 2, 3],
        object: { nested: 'value' },
      }

      const result = await manager.executeWorkflow('bun-serialization-workflow.ts', complexInput)

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.original).toBeDefined()
    })
  })

  describe('Bun Memory Management Compatibility', () => {
    test('should handle Bun memory management', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-memory-workflow.ts', { iterations: 100 })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.iterations).toBe(100)
      expect(result.resultsCount).toBe(100)
      expect(result.memoryUsage).toBeDefined()
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')
    })

    test('should handle ArrayBuffer in Bun workflows', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-memory-workflow.ts', { iterations: 10 })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.resultsCount).toBe(10)
    })
  })

  describe('Bun Error Handling Compatibility', () => {
    test('should handle Bun error handling', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-error-handling-workflow.ts', { shouldThrow: true })

      expect(result).toBeDefined()
      expect(result.success).toBe(false)
      expect(result.error).toBe('Bun-specific error')
      expect(result.stack).toBeDefined()
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')
    })

    test('should handle Bun async error handling', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-error-handling-workflow.ts', { shouldThrowAsync: true })

      expect(result).toBeDefined()
      expect(result.success).toBe(false)
      expect(result.error).toBe('Bun async error')
      expect(result.stack).toBeDefined()
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')
    })

    test('should handle successful Bun workflow execution', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-error-handling-workflow.ts', { test: 'success' })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.input).toEqual({ test: 'success' })
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')
    })
  })

  describe('Bun Concurrency Compatibility', () => {
    test('should handle Bun concurrency', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-concurrency-workflow.ts', { tasks: 5 })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.tasks).toBe(5)
      expect(result.results).toHaveLength(5)
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')

      // Verify all tasks completed
      result.results.forEach((taskResult, index) => {
        expect(taskResult.taskId).toBe(index)
        expect(taskResult.completed).toBe(true)
        expect(taskResult.timestamp).toBeDefined()
      })
    })

    test('should handle high concurrency in Bun', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = Date.now()
      const result = await manager.executeWorkflow('bun-concurrency-workflow.ts', { tasks: 20 })
      const endTime = Date.now()

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.tasks).toBe(20)
      expect(result.results).toHaveLength(20)

      // Should complete reasonably quickly due to Bun's performance
      expect(endTime - startTime).toBeLessThan(1000) // 1 second for 20 concurrent tasks
    })
  })

  describe('Bun Module Loading Compatibility', () => {
    test('should handle Bun module loading', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-module-loading-workflow.ts', { test: 'modules' })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.input).toEqual({ test: 'modules' })
      expect(result.modules).toBeDefined()
      expect(result.modules.fs).toBe('object')
      expect(result.modules.path).toBe('object')
      expect(result.modules.crypto).toBe('object')
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')
    })

    test('should handle dynamic imports in Bun', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-module-loading-workflow.ts', { test: 'dynamic' })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.modules).toBeDefined()
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')
    })
  })

  describe('Bun Performance Compatibility', () => {
    test('should handle Bun performance characteristics', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-performance-workflow.ts', { operations: 1000 })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.operations).toBe(1000)
      expect(result.sum).toBeDefined()
      expect(result.duration).toBeDefined()
      expect(result.operationsPerSecond).toBeDefined()
      expect(result.bunVersion).toBeDefined()
      expect(result.runtime).toBe('bun')

      // Bun should be fast
      expect(result.operationsPerSecond).toBeGreaterThan(1000) // At least 1000 ops/sec
    })

    test('should handle high-performance operations in Bun', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = Date.now()
      const result = await manager.executeWorkflow('bun-performance-workflow.ts', { operations: 10000 })
      const endTime = Date.now()

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.operations).toBe(10000)
      expect(result.operationsPerSecond).toBeGreaterThan(5000) // Bun should be very fast

      // Should complete quickly
      expect(endTime - startTime).toBeLessThan(5000) // 5 seconds for 10k operations
    })
  })

  describe('Bun Runtime Integration', () => {
    test('should verify Bun runtime environment', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-async-workflow.ts', { test: 'runtime' })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.runtime).toBe('bun')
      expect(result.bunVersion).toBeDefined()

      // Verify we're actually running in Bun
      expect(typeof Bun).toBe('object')
      expect(Bun.version).toBeDefined()
    })

    test('should handle Bun-specific APIs in workflows', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const result = await manager.executeWorkflow('bun-async-workflow.ts', { test: 'apis' })

      expect(result).toBeDefined()
      expect(result.success).toBe(true)
      expect(result.runtime).toBe('bun')
      expect(result.bunVersion).toBeDefined()

      // Verify Bun APIs are available
      expect(typeof Bun.sleep).toBe('function')
      expect(typeof Bun.version).toBe('string')
    })
  })

  describe('Bun Workflow Caching', () => {
    test('should cache Bun workflows efficiently', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // Load workflow first time
      const startTime1 = Date.now()
      await manager.loadWorkflow('bun-async-workflow.ts')
      const endTime1 = Date.now()

      // Load workflow second time (should use cache)
      const startTime2 = Date.now()
      await manager.loadWorkflow('bun-async-workflow.ts')
      const endTime2 = Date.now()

      // Second load should be faster or equal (cached)
      expect(endTime2 - startTime2).toBeLessThanOrEqual(endTime1 - startTime1)

      // Verify cache is working
      expect(manager.isolates.size).toBe(1)
    })

    test('should handle multiple Bun workflow types', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // Load multiple workflow types
      await manager.loadWorkflow('bun-async-workflow.ts')
      await manager.loadWorkflow('bun-serialization-workflow.ts')
      await manager.loadWorkflow('bun-memory-workflow.ts')
      await manager.loadWorkflow('bun-error-handling-workflow.ts')
      await manager.loadWorkflow('bun-concurrency-workflow.ts')

      // Verify all workflows are cached
      expect(manager.isolates.size).toBe(5)

      // Execute each workflow
      const results = await Promise.all([
        manager.executeWorkflow('bun-async-workflow.ts', { test: '1' }),
        manager.executeWorkflow('bun-serialization-workflow.ts', { test: '2' }),
        manager.executeWorkflow('bun-memory-workflow.ts', { test: '3' }),
        manager.executeWorkflow('bun-error-handling-workflow.ts', { test: '4' }),
        manager.executeWorkflow('bun-concurrency-workflow.ts', { test: '5' }),
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
})
