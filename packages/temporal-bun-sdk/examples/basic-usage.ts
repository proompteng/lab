#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Basic usage example for @proompteng/temporal-bun-sdk
import { createTemporalClient, WorkflowIsolateManager } from '../src'

async function main() {
  console.log('🎯 Temporal Bun SDK Basic Usage')
  console.log('==============================')

  try {
    // 1. Create Temporal client
    console.log('📡 Step 1: Creating Temporal client...')
    const { client } = await createTemporalClient({
      address: 'http://127.0.0.1:7233',
      namespace: 'default',
    })
    console.log('✅ Client created successfully')

    // 2. Test connection
    console.log('🔍 Step 2: Testing connection...')
    const namespace = await client.describeNamespace('default')
    console.log('✅ Connected to namespace:', namespace.name)

    // 3. Define and execute a workflow
    console.log('⚡ Step 3: Executing workflow...')

    // Create workflows directory
    const workflowsDir = join(process.cwd(), 'examples', 'workflows')
    mkdirSync(workflowsDir, { recursive: true })

    // Define workflow
    const workflowCode = `
export default async function basicWorkflow(input: any) {
  console.log('🚀 Basic workflow started with input:', input)
  
  const { message = 'Hello', name = 'World' } = input
  
  // Simulate work
  await Bun.sleep(50)
  
  const result = {
    success: true,
    greeting: \`\${message}, \${name}!\`,
    timestamp: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun'
  }
  
  console.log('✅ Basic workflow completed')
  return result
}
`

    // Write workflow file
    writeFileSync(join(workflowsDir, 'basic-workflow.ts'), workflowCode)

    // Execute workflow
    const manager = new WorkflowIsolateManager(workflowsDir)
    const result = await manager.executeWorkflow('basic-workflow.ts', {
      message: 'Hello from Bun!',
      name: 'Temporal Developer',
    })

    console.log('✅ Workflow result:', result)

    // 4. Start a workflow on Temporal server
    console.log('🚀 Step 4: Starting workflow on server...')
    const handle = await client.startWorkflow({
      workflowId: 'basic-workflow-001',
      workflowType: 'basic-workflow',
      taskQueue: 'example-queue',
      args: [{ message: 'Hello from server!', name: 'Server User' }],
    })

    console.log('✅ Workflow started on server:', handle.workflowId, handle.runId)

    // 5. Cleanup
    console.log('🧹 Step 5: Cleaning up...')
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
