import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

test('native Alloy accepts Kubernetes RGW line endings and forwards only sanitized Bayn receipts', async () => {
  const alloy = process.env.ALLOY ?? 'alloy'
  const version = spawnSync(alloy, ['--version'], { encoding: 'utf8' })
  expect(version.status).toBe(0)
  expect(version.stdout).toContain('version v1.19.2')
  const config = readFileSync(
    new URL('../../../../../argocd/applications/observability/cluster-metrics-alloy-config.river', import.meta.url),
    'utf8',
  )
  const pipeline = config.match(/loki\.process "bayn_rgw_logs" \{[\s\S]*?\n\}/)?.[0]
  if (!pipeline) throw new Error('Missing Bayn RGW pipeline')
  const hash = 'a'.repeat(64)
  const line = (method: string, path = `bayn-research-captures-1234-abcd/research-capture/sha256/${hash}`) =>
    `2026-10-08T06:47:20.000+0000 thread 1 beast: request client=synthetic-private "${method} /${path} HTTP/1.1" 200 128 - aws-sdk-js synthetic-private latency=0.572006643s`
  const valid = ['PUT', 'GET', 'HEAD', 'DELETE'].flatMap((method) =>
    ['', '\n', '\r\n'].map((ending) => ({ method, line: line(method) + ending })),
  )
  valid.push({
    method: 'GET',
    line:
      line(
        'GET',
        `bayn-research-captures-1234-abcd/research-capture/sha256/${hash}?X-Amz-Credential=synthetic-private`,
      ) + '\n',
  })
  const invalid = [
    'unrelated log synthetic-private\n',
    line('POST') + '\n',
    line('GET', `other-bucket/research-capture/sha256/${hash}`) + '\n',
    line('GET', `bayn-research-captures-1234-abcd/untracked/${hash}`) + '\n',
    line('GET', `bayn-research-captures-1234-abcd/research-capture/sha256/${hash.slice(1)}`) + '\n',
    line('GET').replace('latency=0.572006643s', 'latency=unknown') + '\n',
    line('GET').replace(' 200 128 ', ' invalid 128 ') + '\n',
    line('GET') + '\nsynthetic-private',
  ]
  const listeners = [0, 1].map(() => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }))
  const [apiPort, adminPort] = listeners.map((listener) => listener.port)
  for (const listener of listeners) listener.stop(true)
  const directory = mkdtempSync(join(tmpdir(), 'bayn-rgw-alloy-'))
  const fixturePath = join(directory, 'config.river')
  writeFileSync(
    fixturePath,
    `logging {\n format = "json"\n}\nloki.source.api "fixture" {\n http {\n listen_address = "127.0.0.1"\n listen_port = ${apiPort}\n }\n forward_to = [loki.process.bayn_rgw_logs.receiver]\n}\n${pipeline.replace('loki.write.bayn.receiver', 'loki.echo.fixture.receiver')}\nloki.echo "fixture" {}\n`,
  )
  const child = Bun.spawn(
    [
      alloy,
      'run',
      fixturePath,
      `--storage.path=${join(directory, 'data')}`,
      `--server.http.listen-addr=127.0.0.1:${adminPort}`,
      '--disable-reporting',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const stderr = Bun.readableStreamToText(child.stderr)
  const stdout = Bun.readableStreamToText(child.stdout)
  try {
    const readinessDeadline = Date.now() + 10_000
    let ready = false
    while (Date.now() < readinessDeadline && child.exitCode === null) {
      try {
        ready = (await fetch(`http://127.0.0.1:${adminPort}/-/ready`)).ok
      } catch {
        ready = false
      }
      if (ready) break
      await Bun.sleep(25)
    }
    expect(ready).toBe(true)
    const lines = [...valid.map(({ line: content }) => content), ...invalid]
    const now = BigInt(Date.now()) * 1_000_000n
    const response = await fetch(`http://127.0.0.1:${apiPort}/loki/api/v1/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streams: [
          {
            stream: { fixture: 'bayn-rgw' },
            values: lines.map((content, index) => [(now + BigInt(index)).toString(), content]),
          },
        ],
      }),
    })
    expect(response.status).toBe(204)
    let metrics = ''
    const processingDeadline = Date.now() + 5_000
    while (Date.now() < processingDeadline) {
      metrics = await (await fetch(`http://127.0.0.1:${adminPort}/metrics`)).text()
      const count = metrics.match(
        /loki_process_dropped_lines_total\{[^\n]*reason="non_bayn_rgw_access"[^\n]*\} (\d+)/,
      )?.[1]
      if (Number(count) >= invalid.length) break
      await Bun.sleep(25)
    }
    child.kill('SIGTERM')
    expect(await child.exited).toBe(0)
    await stdout
    const output = await stderr
    const receipts: unknown[] = []
    for (const record of output.trim().split('\n')) {
      const event: unknown = JSON.parse(record)
      if (typeof event !== 'object' || event === null || !('msg' in event) || event.msg !== 'received log entry')
        continue
      if (
        !('entry' in event) ||
        typeof event.entry !== 'string' ||
        !('labels' in event) ||
        typeof event.labels !== 'string'
      )
        throw new Error('Malformed Alloy echo record')
      expect(event.entry).not.toContain('synthetic-private')
      expect(event.entry).not.toContain('bayn-research-captures-')
      expect(event.entry).not.toContain('X-Amz')
      expect(event.labels).not.toContain(hash)
      receipts.push(JSON.parse(event.entry))
    }
    expect(receipts).toEqual(
      valid.map(({ method }) => ({
        schemaVersion: 'bayn.rgw-access.v1',
        method,
        objectHash: hash,
        httpStatus: '200',
        loggedBytes: '128',
        latencySeconds: '0.572006643',
      })),
    )
    expect(metrics).toMatch(
      new RegExp(
        `loki_process_dropped_lines_total\\{[^\\n]*reason="non_bayn_rgw_access"[^\\n]*\\} ${invalid.length}(?:\\n|$)`,
      ),
    )
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
    await Promise.all([stdout, stderr])
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)
