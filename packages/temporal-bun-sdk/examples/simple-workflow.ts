export default async function simpleWorkflow(input: { message?: string; name?: string }) {
  console.log('🚀 Simple workflow started')
  console.log('Input:', input)

  const { message = 'Hello', name = 'World' } = input

  // Simulate some work
  await Bun.sleep(100)

  const result = {
    success: true,
    greeting: `${message}, ${name}!`,
    timestamp: new Date().toISOString(),
    bunVersion: Bun.version,
    runtime: 'bun',
  }

  console.log('✅ Simple workflow completed')
  return result
}
