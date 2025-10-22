// Example workflow using @proompteng/temporal-bun-sdk
type ExampleWorkflowInput = {
  message: string
  timestamp: string
}

export default async function exampleWorkflow(input: ExampleWorkflowInput) {
  console.log('🎯 Example workflow started')
  console.log('Input:', input)

  // Simulate some work
  await Bun.sleep(100)

  // Process the input
  const result = {
    success: true,
    message: `Processed: ${input.message}`,
    timestamp: input.timestamp,
    processedAt: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Example workflow completed')
  return result
}
