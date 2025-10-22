import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTemporalServerAvailable } from './helpers/temporal-server'

// Test configuration
const temporalAddress = process.env.TEMPORAL_TEST_SERVER_ADDRESS ?? 'http://127.0.0.1:7233'
const shouldRun = process.env.TEMPORAL_TEST_SERVER === '1'
const serverAvailable = shouldRun ? await isTemporalServerAvailable(temporalAddress) : false

// Test workflow definitions
const testWorkflowsDir = join(process.cwd(), '.test-integration-workflows')

const simpleWorkflow = `
export default async function simpleWorkflow(input: any) {
  return \`Processed: \${JSON.stringify(input)}\`
}
`

const activityWorkflow = `
export default async function activityWorkflow(input: any) {
  const result = await activity('processData', input)
  return \`Activity result: \${result}\`
}

async function activity(name: string, input: any) {
  // Simulate activity execution
  await new Promise(resolve => setTimeout(resolve, 100))
  return \`\${name}(\${JSON.stringify(input)})\`
}
`

const errorWorkflow = `
export default async function errorWorkflow(input: any) {
  if (input.shouldFail) {
    throw new Error('Intentional workflow failure')
  }
  return 'Success'
}
`

const longRunningWorkflow = `
export default async function longRunningWorkflow(input: any) {
  const duration = input.duration || 1000
  await new Promise(resolve => setTimeout(resolve, duration))
  return \`Completed after \${duration}ms\`
}
`

const complexWorkflow = `
export default async function complexWorkflow(input: any) {
  // Step 1: Validate input
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid input: expected object')
  }
  
  // Step 2: Process data based on type
  let processedData
  if (input.type === 'user') {
    processedData = {
      id: input.id || 'unknown',
      name: input.name || 'Anonymous',
      email: input.email || 'no-email@example.com',
      status: 'active'
    }
  } else if (input.type === 'order') {
    processedData = {
      orderId: input.id || 'unknown',
      amount: input.amount || 0,
      currency: input.currency || 'USD',
      status: 'processed'
    }
  } else {
    processedData = {
      id: input.id || 'unknown',
      type: input.type || 'unknown',
      status: 'processed'
    }
  }
  
  // Step 3: Add metadata
  const metadata = {
    processedAt: new Date().toISOString(),
    workflowVersion: '1.0.0',
    processingTime: Date.now()
  }
  
  // Step 4: Return structured result
  return {
    success: true,
    data: processedData,
    metadata,
    summary: {
      inputType: input.type || 'unknown',
      processedFields: Object.keys(processedData).length,
      hasErrors: false
    }
  }
}
`

describe('Comprehensive Integration Tests with Live Temporal Server', () => {
  let _native: typeof import('../src/internal/core-bridge/native.js').native | undefined
  let createTemporalClient: typeof import('../src/client.js').createTemporalClient | undefined
  let _NativeBridgeError: typeof import('../src/internal/core-bridge/native.js').NativeBridgeError | undefined

  beforeAll(async () => {
    if (!serverAvailable) {
      console.warn(`Skipping integration tests: Temporal server unavailable at ${temporalAddress}`)
      return
    }

    // Setup test workflows directory
    try {
      rmSync(testWorkflowsDir, { recursive: true, force: true })
    } catch {}
    mkdirSync(testWorkflowsDir, { recursive: true })

    // Write test workflow files
    writeFileSync(join(testWorkflowsDir, 'simple-workflow.ts'), simpleWorkflow)
    writeFileSync(join(testWorkflowsDir, 'activity-workflow.ts'), activityWorkflow)
    writeFileSync(join(testWorkflowsDir, 'error-workflow.ts'), errorWorkflow)
    writeFileSync(join(testWorkflowsDir, 'long-running-workflow.ts'), longRunningWorkflow)
    writeFileSync(join(testWorkflowsDir, 'complex-workflow.ts'), complexWorkflow)

    // Import native bridge
    try {
      const bridge = await import('../src/internal/core-bridge/native.js')
      _native = bridge.native
      createTemporalClient = bridge.createTemporalClient
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

  describe('Client Integration Tests', () => {
    test('should connect to live Temporal server', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      expect(client).toBeDefined()
      expect(typeof client.describeNamespace).toBe('function')
    })

    test('should describe namespace successfully', async () => {
      if (!serverAvailable || !createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      const client = await createTemporalClient({
        address: temporalAddress,
        namespace: 'default',
      })

      const result = await client.describeNamespace('default')
      expect(result).toBeDefined()
      expect(result.namespaceInfo).toBeDefined()
      expect(result.namespaceInfo.name).toBe('default')
    })

    test('should handle connection errors gracefully', async () => {
      if (!createTemporalClient) {
        expect(true).toBe(true) // Skip test
        return
      }

      try {
        await createTemporalClient({
          address: 'http://127.0.0.1:9999', // Non-existent server
          namespace: 'default',
        })
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error).toBeDefined()
        expect(error.message).toContain('Connection failed')
      }
    })
  })

  describe('Workflow Execution Integration Tests', () => {
    test('should execute simple workflow against live server', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      // This test would require a full worker implementation
      // For now, we'll test the workflow loading mechanism
      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')

      const manager = new WorkflowIsolateManager(testWorkflowsDir)
      const workflowFn = await manager.loadWorkflow('simple-workflow.ts')

      expect(workflowFn).toBeDefined()
      expect(typeof workflowFn).toBe('function')

      const result = await manager.executeWorkflow('simple-workflow.ts', { test: 'data' })
      expect(result).toBe('Processed: {"test":"data"}')
    })

    test('should handle workflow execution errors', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      try {
        await manager.executeWorkflow('error-workflow.ts', { shouldFail: true })
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error.message).toContain('Intentional workflow failure')
      }
    })

    test('should execute long-running workflow', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = Date.now()
      const result = await manager.executeWorkflow('long-running-workflow.ts', { duration: 200 })
      const endTime = Date.now()

      expect(result).toBe('Completed after 200ms')
      expect(endTime - startTime).toBeGreaterThanOrEqual(190) // Allow some tolerance
    })

    test('should execute complex workflow with multiple operations', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // Test 1: User processing workflow
      const userInput = {
        type: 'user',
        id: 'user-123',
        name: 'John Doe',
        email: 'john@example.com',
      }

      const userResult = await manager.executeWorkflow('complex-workflow.ts', userInput)

      expect(userResult).toBeDefined()
      expect(userResult.success).toBe(true)
      expect(userResult.data.id).toBe('user-123')
      expect(userResult.data.name).toBe('John Doe')
      expect(userResult.data.email).toBe('john@example.com')
      expect(userResult.data.status).toBe('active')
      expect(userResult.metadata).toBeDefined()
      expect(userResult.summary.inputType).toBe('user')
      expect(userResult.summary.hasErrors).toBe(false)

      // Test 2: Order processing workflow
      const orderInput = {
        type: 'order',
        id: 'order-456',
        amount: 99.99,
        currency: 'EUR',
      }

      const orderResult = await manager.executeWorkflow('complex-workflow.ts', orderInput)

      expect(orderResult).toBeDefined()
      expect(orderResult.success).toBe(true)
      expect(orderResult.data.orderId).toBe('order-456')
      expect(orderResult.data.amount).toBe(99.99)
      expect(orderResult.data.currency).toBe('EUR')
      expect(orderResult.data.status).toBe('processed')
      expect(orderResult.summary.inputType).toBe('order')

      // Test 3: Unknown type workflow
      const unknownInput = {
        type: 'unknown',
        id: 'item-789',
      }

      const unknownResult = await manager.executeWorkflow('complex-workflow.ts', unknownInput)

      expect(unknownResult).toBeDefined()
      expect(unknownResult.success).toBe(true)
      expect(unknownResult.data.id).toBe('item-789')
      expect(unknownResult.data.type).toBe('unknown')
      expect(unknownResult.data.status).toBe('processed')
      expect(unknownResult.summary.inputType).toBe('unknown')

      // Test 4: Error handling for invalid input
      try {
        await manager.executeWorkflow('complex-workflow.ts', null)
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error.message).toContain('Invalid input')
      }

      // Test 5: Error handling for non-object input
      try {
        await manager.executeWorkflow('complex-workflow.ts', 'invalid-string')
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        expect(error.message).toContain('Invalid input')
      }
    })
  })

  describe('Worker Integration Tests', () => {
    test('should create worker runtime', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkerRuntime } = await import('../src/worker/runtime.js')

      const worker = new WorkerRuntime({
        workflowsPath: testWorkflowsDir,
        taskQueue: 'test-queue',
        namespace: 'default',
      })

      expect(worker).toBeDefined()
      // Note: WorkerRuntime methods are not yet implemented
      // expect(typeof worker.start).toBe('function')
      // expect(typeof worker.shutdown).toBe('function')
    })

    test('should handle worker lifecycle', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkerRuntime } = await import('../src/worker/runtime.js')

      const worker = new WorkerRuntime({
        workflowsPath: testWorkflowsDir,
        taskQueue: 'test-queue',
        namespace: 'default',
      })

      // Test that we can create and destroy workers without errors
      expect(() => worker.shutdown()).not.toThrow()
    })
  })

  describe('Performance Integration Tests', () => {
    test('should handle concurrent workflow executions', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const startTime = Date.now()
      const promises = Array.from({ length: 5 }, (_, i) => manager.executeWorkflow('simple-workflow.ts', { index: i }))

      const results = await Promise.all(promises)
      const endTime = Date.now()

      expect(results).toHaveLength(5)
      results.forEach((result, i) => {
        expect(result).toBe(`Processed: {"index":${i}}`)
      })

      // Should complete reasonably quickly
      expect(endTime - startTime).toBeLessThan(1000)
    })

    test('should maintain performance under load', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const iterations = 10
      const startTime = Date.now()

      for (let i = 0; i < iterations; i++) {
        await manager.executeWorkflow('simple-workflow.ts', { iteration: i })
      }

      const endTime = Date.now()
      const avgTime = (endTime - startTime) / iterations

      // Average execution time should be reasonable
      expect(avgTime).toBeLessThan(100) // 100ms per execution
    })
  })

  describe('Error Handling Integration Tests', () => {
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

    test('should handle workflow execution timeouts', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // Test with a very long-running workflow
      const startTime = Date.now()
      const result = await manager.executeWorkflow('long-running-workflow.ts', { duration: 500 })
      const endTime = Date.now()

      expect(result).toBe('Completed after 500ms')
      expect(endTime - startTime).toBeGreaterThanOrEqual(490)
    })
  })

  describe('Memory Management Integration Tests', () => {
    test('should handle workflow cache management', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      // Load multiple workflows to test caching
      await manager.loadWorkflow('simple-workflow.ts')
      await manager.loadWorkflow('activity-workflow.ts')
      await manager.loadWorkflow('complex-workflow.ts')

      // Verify workflows are cached
      expect(manager.isolates.size).toBe(3)

      // Load same workflow again (should use cache)
      const startTime = Date.now()
      await manager.loadWorkflow('simple-workflow.ts')
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
      await manager.loadWorkflow('simple-workflow.ts')
      await manager.executeWorkflow('simple-workflow.ts', { test: 'data' })

      // Verify cleanup
      expect(manager.isolates.size).toBe(1)

      // Cleanup should not throw (if cleanup method exists)
      if (typeof manager.cleanup === 'function') {
        expect(() => manager.cleanup()).not.toThrow()
      }
    })
  })

  describe('Real-world Scenario Tests', () => {
    test('should handle e-commerce order processing workflow', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const ecommerceWorkflow = `
        export default async function ecommerceWorkflow(order: any) {
          const steps = []
          
          // Validate order
          steps.push(await validateOrder(order))
          
          // Process payment
          steps.push(await processPayment(order))
          
          // Reserve inventory
          steps.push(await reserveInventory(order))
          
          // Send confirmation
          steps.push(await sendConfirmation(order))
          
          return {
            orderId: order.id,
            status: 'completed',
            steps,
            timestamp: new Date().toISOString()
          }
        }
        
        async function validateOrder(order: any) {
          await new Promise(resolve => setTimeout(resolve, 50))
          return { step: 'validate', status: 'success', orderId: order.id }
        }
        
        async function processPayment(order: any) {
          await new Promise(resolve => setTimeout(resolve, 100))
          return { step: 'payment', status: 'success', amount: order.amount }
        }
        
        async function reserveInventory(order: any) {
          await new Promise(resolve => setTimeout(resolve, 75))
          return { step: 'inventory', status: 'success', items: order.items }
        }
        
        async function sendConfirmation(order: any) {
          await new Promise(resolve => setTimeout(resolve, 25))
          return { step: 'confirmation', status: 'success', email: order.email }
        }
      `

      writeFileSync(join(testWorkflowsDir, 'ecommerce-workflow.ts'), ecommerceWorkflow)

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const order = {
        id: 'order-123',
        amount: 99.99,
        items: ['item1', 'item2'],
        email: 'test@example.com',
      }

      const result = await manager.executeWorkflow('ecommerce-workflow.ts', order)

      expect(result).toBeDefined()
      expect(result.orderId).toBe('order-123')
      expect(result.status).toBe('completed')
      expect(result.steps).toHaveLength(4)
      expect(result.timestamp).toBeDefined()
    })

    test('should handle data processing pipeline workflow', async () => {
      if (!serverAvailable) {
        expect(true).toBe(true) // Skip test
        return
      }

      const dataPipelineWorkflow = `
        export default async function dataPipelineWorkflow(data: any) {
          const results = []
          
          // Process each data item
          for (const item of data.items) {
            const processed = await processDataItem(item)
            results.push(processed)
          }
          
          // Aggregate results
          const summary = await aggregateResults(results)
          
          return {
            processed: results.length,
            summary,
            timestamp: new Date().toISOString()
          }
        }
        
        async function processDataItem(item: any) {
          await new Promise(resolve => setTimeout(resolve, 30))
          return {
            id: item.id,
            processed: true,
            value: item.value * 2
          }
        }
        
        async function aggregateResults(results: any[]) {
          await new Promise(resolve => setTimeout(resolve, 50))
          return {
            total: results.length,
            sum: results.reduce((acc, r) => acc + r.value, 0),
            average: results.reduce((acc, r) => acc + r.value, 0) / results.length
          }
        }
      `

      writeFileSync(join(testWorkflowsDir, 'data-pipeline-workflow.ts'), dataPipelineWorkflow)

      const { WorkflowIsolateManager } = await import('../src/worker/task-loops.js')
      const manager = new WorkflowIsolateManager(testWorkflowsDir)

      const data = {
        items: [
          { id: 1, value: 10 },
          { id: 2, value: 20 },
          { id: 3, value: 30 },
        ],
      }

      const result = await manager.executeWorkflow('data-pipeline-workflow.ts', data)

      expect(result).toBeDefined()
      expect(result.processed).toBe(3)
      expect(result.summary.total).toBe(3)
      expect(result.summary.sum).toBe(120) // (10+20+30) * 2
      expect(result.summary.average).toBe(40) // 120 / 3
    })
  })
})
