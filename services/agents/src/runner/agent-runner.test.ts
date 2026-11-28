import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

const entrypoint = fileURLToPath(new URL('../../scripts/codex/agent-runner.ts', import.meta.url))

it.each([
  { signal: 'SIGTERM' as const, code: 143, stalled: true },
  { signal: 'SIGINT' as const, code: 130, stalled: false },
])(
  'flushes a terminal heartbeat, retained log and status on $signal (stalled storage: $stalled)',
  async ({ signal, code, stalled }) => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-signal-'))
    const runPath = join(dir, 'run.json')
    const specPath = join(dir, 'agent-runner.json')
    const logPath = join(dir, 'runner.log')
    const statusPath = join(dir, 'status.json')
    const pidPath = join(dir, 'app-server.pid')
    const binaryPath = join(dir, 'hanging-app-server')
    onTestFinished(() => rm(dir, { recursive: true, force: true }))
    await writeFile(runPath, '{}')
    await writeFile(
      binaryPath,
      `#!/usr/bin/env bun
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const input = createInterface({ input: process.stdin })
input.on('close', () => process.exit(0))
input.on('line', (line) => {
  const { id, method } = JSON.parse(line)
  if (method === 'initialize') send({ id, result: {} })
  if (method === 'thread/start') send({ id, result: { thread: { id: 'thread' } } })
  if (method === 'turn/start') send({ id, result: { turn: { id: 'turn', status: 'inProgress', items: [] } } })
  // Ignore turn/interrupt so the runner must bound the RPC and reap the child.
})
`,
      { mode: 0o700 },
    )
    await writeFile(
      specPath,
      JSON.stringify({
        provider: 'run-signal-fixture',
        payloads: { eventFilePath: runPath },
        artifacts: { logPath, statusPath },
        providerSpec: { outputArtifacts: [{ name: 'runner-log', path: logPath, key: 'runner.log' }] },
        adapter: { type: 'codex-app-server', codex: { binaryPath, prompt: 'block until cancelled' } },
      }),
    )

    const puts: { url: string; body: string }[] = []
    const startingPut = Promise.withResolvers<void>()
    const terminalPut = Promise.withResolvers<void>()
    const storage = createServer((request, response) => {
      let body = ''
      request
        .setEncoding('utf8')
        .on('data', (chunk: string) => {
          body += chunk
        })
        .on('end', () => {
          const url = request.url ?? ''
          puts.push({ url, body })
          if (url.includes('runner-telemetry') && body.includes('"state":"starting"')) startingPut.resolve()
          if (url.includes('runner-telemetry') && body.includes('"state":"finished"')) terminalPut.resolve()
          if (!stalled) response.end()
        })
    })
    onTestFinished(() => {
      storage.closeAllConnections()
      storage.close()
    })
    storage.listen(0, '127.0.0.1')
    await once(storage, 'listening')
    const address = storage.address()
    if (!address || typeof address === 'string') throw new Error('fixture storage did not listen on TCP')

    const runner = spawn('bun', [entrypoint, specPath], {
      env: {
        PATH: process.env.PATH,
        AGENTS_RUNNER_PSTACK_ENABLED: 'false',
        AGENT_RUN_NAMESPACE: 'tests',
        AGENT_RUN_UID: 'signal-test',
        AGENTS_ARTIFACTS_ENDPOINT: `http://127.0.0.1:${address.port}`,
        AGENTS_ARTIFACTS_ACCESS_KEY_ID: 'fixture',
        AGENTS_ARTIFACTS_SECRET_ACCESS_KEY: 'fixture',
        AGENTS_ARTIFACTS_BUCKET: 'fixture',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const closed = once(runner, 'close')
    const turnStarted = Promise.withResolvers<void>()
    let stdout = ''
    let stderr = ''
    runner.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes('"phase":"first_turn_started"')) turnStarted.resolve()
    })
    runner.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    let appServerPid: number | undefined
    onTestFinished(async () => {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
      await closed
      if (appServerPid) {
        try {
          process.kill(appServerPid, 'SIGKILL')
        } catch {
          /* already reaped */
        }
      }
    })
    await Promise.race([
      Promise.all([turnStarted.promise, startingPut.promise]),
      closed,
      delay(3_000, undefined, { ref: false }),
    ])
    expect(stdout, stderr).toContain('"phase":"first_turn_started"')
    expect(puts.some(({ body }) => body.includes('"state":"starting"'))).toBe(true)
    const pid = Number(await readFile(pidPath, 'utf8'))
    appServerPid = pid
    const signalledAt = performance.now()
    expect(runner.kill(signal)).toBe(true)
    if (stalled) {
      await Promise.race([terminalPut.promise, closed])
      expect(runner.kill('SIGINT')).toBe(true) // Ignore the second signal while finishing the first.
    }
    expect(await closed).toEqual([code, null])
    expect(performance.now() - signalledAt).toBeLessThan(5_000)
    expect(stderr).not.toContain('shutdown exceeded')
    expect(() => process.kill(pid, 0)).toThrow()
    appServerPid = undefined
    expect(stdout).toContain('"state":"finished"')
    expect(await readFile(logPath, 'utf8')).toContain('"state":"finished"')
    expect(puts.some(({ url, body }) => url.includes('runner-telemetry') && body.includes('"state":"finished"'))).toBe(
      true,
    )
    expect(puts.some(({ url, body }) => url.endsWith('/runner.log') && body.includes('"state":"finished"'))).toBe(true)
    const status = JSON.parse(await readFile(statusPath, 'utf8'))
    expect(status).toMatchObject({
      status: 'cancelled',
      exitCode: code,
      telemetry: { state: 'finished' },
    })
    expect(status.error).toContain(signal)
    if (stalled) expect(status.error).toContain('shutdown budget')
    else
      expect(status.artifacts.outputArtifacts).toContainEqual(
        expect.objectContaining({ url: 's3://fixture/runner.log' }),
      )
  },
  10_000,
)
