import assert from 'node:assert/strict'
import { resolve } from 'node:path'

// Exercise the final Nitro bundle, rather than importing workspace source or the SDK directly.
export const verifyBuiltServer = async (serviceRoot: string) => {
  const root = resolve(serviceRoot)
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
  const port = reservation.port
  await reservation.stop(true)
  const child = Bun.spawn([process.execPath, resolve(root, '.output/server/index.mjs')], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      PORT: String(port),
      NITRO_PORT: String(port),
      AGENTS_CONTROLLER_ENABLED: '0',
      AGENTS_ORCHESTRATION_CONTROLLER_ENABLED: '0',
      AGENTS_SUPPORTING_CONTROLLER_ENABLED: '0',
      AGENTS_PRIMITIVES_RECONCILER_ENABLED: '0',
      AGENTS_MIGRATIONS: 'skip',
      OTEL_SDK_DISABLED: 'true',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  let failure: Error | undefined
  try {
    const deadline = Date.now() + 15_000
    let response: Response | undefined
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Bundled server exited with code ${child.exitCode}`)
      response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) }).catch(
        () => undefined,
      )
      if (response) break
      await Bun.sleep(100)
    }
    assert.ok(response, 'Bundled server did not answer /health within 15 seconds')
    const body = await response.text()
    assert.equal(response.status, 200, `Bundled server /health failed: ${body.slice(0, 2_000)}`)
    const health = JSON.parse(body)
    assert.equal(health.status, 'ok')
    assert.equal(health.service, 'agents')
    assert.equal(health.agentsController.enabled, false)
    console.log(
      JSON.stringify({ bundle: resolve(root, '.output/server/index.mjs'), status: response.status, service: 'agents' }),
    )
  } catch (error) {
    failure = error instanceof Error ? error : new Error('Bundled server verification failed', { cause: error })
  } finally {
    child.kill('SIGTERM')
    const hardStop = setTimeout(() => child.kill('SIGKILL'), 2_000)
    await child.exited
    clearTimeout(hardStop)
  }
  const logs = `${await stdout}\n${await stderr}`
  if (failure) throw new Error(`${failure.message}\n${logs.slice(-4_000)}`, { cause: failure })
}

if (import.meta.main) {
  const root = process.argv[2]
  if (!root) throw new Error('Usage: verify-built-server.ts <service-root>')
  await verifyBuiltServer(root)
}
