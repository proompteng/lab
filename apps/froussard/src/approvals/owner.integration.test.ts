import { Webhooks } from '@octokit/webhooks'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { approvalObjectKey, approvalServiceName, approvalSignaturePayload, type ApprovalCommand } from './contracts'
import { startGithubFixture } from './github.integration.test-support'
import { enqueueApproval } from './ingress'

const enabled = process.env.FROUSSARD_RESTATE_INTEGRATION === '1'
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim()
const serviceRoot = fileURLToPath(new URL('../..', import.meta.url))
type Worker = { process: ChildProcess; port: number; output: string[] }

describe.skipIf(!enabled)('real Restate approval ownership', () => {
  const container = `froussard-approval-${randomUUID()}`
  const signer = new Webhooks({ secret: 'test-webhook-secret' })
  let directory = ''
  let admin = ''
  let ingress = ''
  let github: Awaited<ReturnType<typeof startGithubFixture>>
  let workers: Worker[] = []
  let proxy: Server
  let proxyPort = 0
  let nextWorker = 0
  let number = 1000

  const waitForRestate = async () => {
    admin = `http://127.0.0.1:${docker('port', container, '9070/tcp').split(':').at(-1)}`
    ingress = `http://127.0.0.1:${docker('port', container, '8080/tcp').split(':').at(-1)}`
    const deadline = Date.now() + 60_000
    let lastError = ''
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${admin}/services`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) return
        lastError = `HTTP ${response.status}: ${await response.text()}`
      } catch (error) {
        lastError = String(error)
      }
      await pause(100)
    }
    throw new Error(`Restate admin did not start: ${lastError}; ${docker('logs', '--tail', '30', container)}`)
  }
  const startWorkers = async () => {
    for (let i = 0; i < 2; i++) {
      const child = spawn('bun', ['src/approvals/integration-worker.test-support.ts'], {
        cwd: serviceRoot,
        env: { ...process.env, FROUSSARD_TEST_GITHUB_URL: github.origin },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const output: string[] = []
      const port = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`SDK worker did not start: ${output.join('\n')}`)), 10_000)
        if (!child.stdout || !child.stderr) return reject(new Error('SDK worker output missing'))
        createInterface({ input: child.stdout }).on('line', (line) => {
          output.push(line)
          try {
            const candidate: unknown = JSON.parse(line)
            if (
              typeof candidate === 'object' &&
              candidate !== null &&
              'port' in candidate &&
              typeof candidate.port === 'number'
            ) {
              clearTimeout(timeout)
              resolve(candidate.port)
            }
          } catch {}
        })
        child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()))
        child.once('exit', (code) => {
          clearTimeout(timeout)
          reject(new Error(`SDK worker exited ${code}: ${output.join('\n')}`))
        })
      })
      workers.push({ process: child, port, output })
    }
  }
  const stopWorkers = async () => {
    const previous = workers
    workers = []
    await Promise.all(
      previous.map(
        (worker) =>
          new Promise<void>((resolve) => {
            if (worker.process.exitCode !== null || worker.process.signalCode !== null) return resolve()
            worker.process.once('exit', () => resolve())
            worker.process.kill('SIGKILL')
          }),
      ),
    )
  }
  const command = (deliveryId = randomUUID()): ApprovalCommand => ({
    repositoryFullName: 'owner/repo',
    pullNumber: number,
    deliveryId,
  })
  const call = async (input: ApprovalCommand, options: { key?: string; signature?: string } = {}) => {
    const body = JSON.stringify({
      ...input,
      signature: options.signature ?? (await signer.sign(approvalSignaturePayload(input))),
    })
    const deadline = Date.now() + 100_000
    let lastError = ''
    while (Date.now() < deadline) {
      try {
        const url = `${ingress}/${approvalServiceName}/${encodeURIComponent(options.key ?? approvalObjectKey(input))}/approve`
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': input.deliveryId },
          body,
          signal: AbortSignal.timeout(15_000),
        })
        if (response.status < 500) return { status: response.status, body: await response.json() }
        lastError = `HTTP ${response.status}: ${await response.text()}`
      } catch (error) {
        lastError = String(error)
      }
      await pause(100)
    }
    throw new Error(
      `Approval did not complete: ${lastError}; fixture errors: ${github.errors.join('; ')}; SDK: ${workers
        .flatMap((w) => w.output)
        .slice(-12)
        .join('\n')}`,
    )
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'froussard-restate-'))
    const data = join(directory, 'data')
    await mkdir(data, { mode: 0o700 })
    const gateway = process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []
    docker(
      'run',
      '--detach',
      '--name',
      container,
      '--label',
      'codex.froussard-approval-test=true',
      '--user',
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--mount',
      `type=bind,source=${data},target=/restate-data`,
      '--tmpfs',
      '/tmp:rw,size=128m,mode=1777',
      '--env',
      'RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE=256 MiB',
      '-p',
      '127.0.0.1::9070',
      '-p',
      '127.0.0.1::8080',
      ...gateway,
      'docker.restate.dev/restatedev/restate:1.8.1@sha256:cd5ee1abb1b3f91e813e327a024779280938aaff991ccdc5b241a3a3a4bddce1',
      '--base-dir',
      '/restate-data',
      '--listen-mode',
      'tcp',
      '--default-num-partitions',
      '1',
      '--log-format',
      'compact',
    )
    await waitForRestate()
  }, 90_000)

  beforeEach(async () => {
    number++
    github = await startGithubFixture()
    await startWorkers()
    proxy = createServer((request, response) => {
      const worker = workers[nextWorker++ % Math.max(1, workers.length)]
      if (!worker) {
        response.writeHead(503).end()
        return
      }
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: worker.port,
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers)
          result.on('error', () => response.destroy())
          result.pipe(response)
        },
      )
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(503)
        response.end()
      })
      request.pipe(upstream)
      response.on('close', () => upstream.destroy())
    })
    await new Promise<void>((resolve) => proxy.listen(0, '0.0.0.0', resolve))
    const address = proxy.address()
    if (address === null || typeof address === 'string') throw new Error('Missing SDK proxy port')
    proxyPort = address.port
    const registration = await fetch(`${admin}/deployments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: `http://host.docker.internal:${proxyPort}`, use_http_11: true }),
    })
    if (!registration.ok)
      throw new Error(`SDK registration failed: ${registration.status} ${await registration.text()}`)
  }, 30_000)
  afterEach(async () => {
    await stopWorkers()
    if (proxy) {
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
    if (github) {
      expect(github.errors).toEqual([])
      await github.stop()
    }
  })
  afterAll(async () => {
    try {
      await writeFile(join(tmpdir(), `${container}.log`), docker('logs', container))
      docker('rm', '-f', container)
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  })

  it('submits one approval for concurrent completion deliveries across two SDK processes and stale review lists', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => call(command())))
    expect(results.every((result) => result.status === 200)).toBe(true)
    expect(github.state.approvalPosts).toBe(1)
    expect(github.state.draftPosts).toBe(1)
    expect([...github.state.reviews.values()].map((review) => review.state)).toEqual(['APPROVED'])
  }, 120_000)

  it('durably accepts redelivery of the same signed webhook command once', async () => {
    const input = command()
    await Promise.all(
      Array.from({ length: 2 }, () =>
        enqueueApproval({ command: input, ingressOrigin: ingress, sign: (text) => signer.sign(text) }),
      ),
    )
    expect((await call(input)).body).toMatchObject({ status: 'APPROVED' })
    expect(github.state.draftPosts).toBe(1)
    expect(github.state.approvalPosts).toBe(1)
  }, 120_000)

  it.each(['draft', 'submit'] as const)(
    'recovers after a %s side effect loses its response and both SDK processes restart',
    async (stage) => {
      const reached = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const hook = async () => {
        reached.resolve()
        await release.promise
      }
      if (stage === 'draft') github.state.afterDraft = hook
      else github.state.afterSubmit = hook
      const pending = call(command())
      await Promise.race([
        reached.promise,
        pause(15_000).then(() => {
          throw new Error('GitHub side effect was not reached')
        }),
      ])
      await stopWorkers()
      github.state.afterDraft = async () => {}
      github.state.afterSubmit = async () => {}
      release.resolve()
      await startWorkers()
      const result = await pending
      expect(result.status).toBe(200)
      expect(github.state.approvalPosts).toBe(1)
      expect(github.state.draftPosts).toBe(1)
      expect((await call(command())).status).toBe(200)
      expect(github.state.approvalPosts).toBe(1)
    },
    120_000,
  )

  it('retains the checkpoint across an abrupt Restate server restart after GitHub accepted approval', async () => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    github.state.afterSubmit = async () => {
      reached.resolve()
      await release.promise
    }
    const pending = call(command())
    await Promise.race([
      reached.promise,
      pause(15_000).then(() => {
        throw new Error('Approval was not reached')
      }),
    ])
    await stopWorkers()
    docker('kill', '--signal=KILL', container)
    github.state.afterSubmit = async () => {}
    release.resolve()
    docker('start', container)
    await waitForRestate()
    await startWorkers()
    expect((await pending).status).toBe(200)
    expect((await call(command())).status).toBe(200)
    expect(github.state.approvalPosts).toBe(1)
    expect(github.state.draftPosts).toBe(1)
  }, 120_000)

  it('rechecks CI after draft creation and reuses the draft when readiness returns', async () => {
    github.state.afterDraft = async () => {
      github.state.ci = 'failure'
    }
    expect((await call(command())).body).toMatchObject({ status: 'NOT_READY' })
    expect(github.state.approvalPosts).toBe(0)
    github.state.afterDraft = async () => {}
    github.state.ci = 'success'
    expect((await call(command())).body).toMatchObject({ status: 'APPROVED' })
    expect(github.state.draftPosts).toBe(1)
    expect(github.state.approvalPosts).toBe(1)
  }, 120_000)

  it('abandons an obsolete draft when the head changes and approves only the new head', async () => {
    github.state.afterDraft = async () => {
      github.state.head = 'b'.repeat(40)
    }
    expect((await call(command())).body).toMatchObject({ status: 'NOT_READY' })
    expect(github.state.approvalPosts).toBe(0)
    github.state.afterDraft = async () => {}
    expect((await call(command())).body).toMatchObject({ status: 'APPROVED' })
    expect(github.state.approvalPosts).toBe(1)
    expect([...github.state.reviews.values()]).toMatchObject([{ state: 'APPROVED', commit_id: 'b'.repeat(40) }])
  }, 120_000)

  it('rejects forged commands and commands sent to a different PR key', async () => {
    expect((await call(command(), { signature: 'sha256=' + '0'.repeat(64) })).status).toBe(403)
    expect((await call(command(), { key: 'owner/repo#999' })).status).toBe(403)
    expect(github.state.requestCount).toBe(0)
  }, 120_000)
})
