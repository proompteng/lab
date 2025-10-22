#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Example usage of @proompteng/temporal-bun-sdk
import { createTemporalClient, WorkflowIsolateManager } from '@proompteng/temporal-bun-sdk'

async function main() {
  console.log('🚀 Temporal Bun SDK Example')
  console.log('============================')

  try {
    // Create Temporal client
    console.log('📡 Creating Temporal client...')
    const { client } = await createTemporalClient({
      address: 'http://127.0.0.1:7233',
      namespace: 'default',
    })

    console.log('✅ Client created successfully')

    // Test client connection
    console.log('🔍 Testing client connection...')
    const namespace = await client.describeNamespace('default')
    console.log('✅ Namespace:', namespace.name)

    // Create workflows directory
    const workflowsDir = join(process.cwd(), 'src', 'workflows')
    mkdirSync(workflowsDir, { recursive: true })

    // Define example workflow
    const workflowCode = `
export default async function exampleWorkflow(input: any) {
  console.log('🎯 Example workflow started')
  console.log('Input:', input)
  
  const { message = 'Hello', name = 'World' } = input
  
  // Simulate some work
  await Bun.sleep(100)
  
  const result = {
    success: true,
    greeting: \`\${message}, \${name}!\`,
    timestamp: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun'
  }
  
  console.log('✅ Example workflow completed')
  return result
}
`

    // Write workflow file
    writeFileSync(join(workflowsDir, 'example-workflow.ts'), workflowCode)

    // Execute workflow
    console.log('⚡ Running example workflow...')
    const manager = new WorkflowIsolateManager(workflowsDir)

    const result = await manager.executeWorkflow('example-workflow.ts', {
      message: 'Hello from @proompteng/temporal-bun-sdk!',
      name: 'Bun Developer',
    })

    console.log('✅ Workflow result:', result)

    // Start workflow on server
    console.log('🚀 Starting workflow on server...')
    const handle = await client.startWorkflow({
      workflowId: 'example-workflow-001',
      workflowType: 'example-workflow',
      taskQueue: 'example-queue',
      args: [{ message: 'Hello from server!', name: 'Server User' }],
    })

    console.log('✅ Workflow started on server:', handle.workflowId, handle.runId)

    // Close client
    await client.close()
    console.log('✅ Client closed')

    console.log('🎉 Example completed successfully!')
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  }
}

// Run the example
if (import.meta.main) {
  main()
}
