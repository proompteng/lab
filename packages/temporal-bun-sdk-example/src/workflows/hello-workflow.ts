// Hello workflow using @proompteng/temporal-bun-sdk
type HelloWorkflowInput = {
  name?: string
  message?: string
}

export default async function helloWorkflow(input: HelloWorkflowInput) {
  console.log('👋 Hello workflow started')
  console.log('Input:', input)

  const { name = 'World', message = 'Hello' } = input

  // Simulate some work
  await Bun.sleep(100)

  const result = {
    success: true,
    greeting: `${message}, ${name}!`,
    timestamp: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Hello workflow completed')
  return result
}
