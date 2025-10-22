export default async function basicWorkflow(input: { message?: string; name?: string }) {
  console.log('🚀 Basic workflow started with input:', input)

  const { message = 'Hello', name = 'World' } = input

  // Simulate work
  await Bun.sleep(50)

  const result = {
    success: true,
    greeting: `${message}, ${name}!`,
    timestamp: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Basic workflow completed')
  return result
}
