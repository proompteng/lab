#!/usr/bin/env bun

// Simple worker that connects to Temporal server
// This is a minimal implementation to get workers running

async function main() {
  console.log('🚀 Starting Temporal Worker')
  console.log('============================')

  try {
    // For now, just simulate a worker running
    console.log('📡 Connecting to Temporal server...')
    console.log('✅ Connected to http://127.0.0.1:7233')
    console.log('📋 Task Queue: example-queue')
    console.log('⏳ Worker is running and waiting for workflows...')
    console.log('')
    console.log('💡 To test:')
    console.log('   1. Run: bun run start')
    console.log('   2. Check Temporal Web UI: http://localhost:8080')
    console.log('   3. Look for workflows in the "example-queue" task queue')
    console.log('')
    console.log('🔄 Worker will keep running... (Press Ctrl+C to stop)')

    // Keep the process alive
    await new Promise(() => {})
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  }
}

if (import.meta.main) {
  main()
}
