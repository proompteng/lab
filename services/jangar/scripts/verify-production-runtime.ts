import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const serviceRoot = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
const port = reservation.port
await reservation.stop(true)

const server = Bun.spawn([process.execPath, '.output/server/index.mjs'], {
  cwd: serviceRoot,
  env: {
    PATH: process.env.PATH,
    HOST: '127.0.0.1',
    PORT: String(port),
    JANGAR_SERVER_PROFILE: 'test',
    JANGAR_CHAT_STATE_BACKEND: 'memory',
    JANGAR_MOCK_CODEX: 'true',
    AGENTS_SERVICE_BASE_URL: 'http://127.0.0.1:1',
  },
  stdout: 'pipe',
  stderr: 'pipe',
})
const stdout = new Response(server.stdout).text()
const stderr = new Response(server.stderr).text()
const baseUrl = `http://127.0.0.1:${port}`

try {
  const deadline = Date.now() + 20_000
  let healthy = false
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) })
      const health = await response.json()
      assert.equal(response.status, 200)
      assert.equal(health.status, 'ok')
      assert.equal(health.service, 'jangar')
      healthy = true
      break
    } catch {
      await Bun.sleep(100)
    }
  }
  assert(healthy, 'production server must start and serve /health')

  const models = await fetch(`${baseUrl}/openai/v1/models`, { signal: AbortSignal.timeout(2_000) })
  assert.equal(models.status, 200)
  const catalog = await models.json()
  assert.equal(catalog.object, 'list')
  assert(catalog.data.length > 0, 'model catalog must contain a model')

  const invalidChat = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: 'invalid' }),
    signal: AbortSignal.timeout(2_000),
  })
  assert.equal(invalidChat.status, 400, 'chat schema must reject invalid messages')
  const chat = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], stream: false }),
    signal: AbortSignal.timeout(5_000),
  })
  assert.equal(chat.status, 200, 'chat service layers must execute a completion')
  const completion = await chat.json()
  assert.equal(completion.choices[0].message.content.trim(), 'Mock Codex ready.')
  assert.equal(server.exitCode, null, 'production server must remain running')
  console.log('Jangar production runtime passed: health, model catalog, chat validation and completion')
} catch (error) {
  if (server.exitCode === null) server.kill('SIGKILL')
  await server.exited
  console.error(await stdout, await stderr)
  throw error
} finally {
  if (server.exitCode === null) server.kill('SIGKILL')
  await server.exited
}
