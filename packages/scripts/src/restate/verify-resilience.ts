#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import YAML from 'yaml'

const [image, output] = process.argv.slice(2)
if (!image || !output) throw new Error('Usage: bun verify-resilience.ts <image> <evidence-directory>')
const directory = resolve(output)
mkdirSync(directory, { recursive: true })
const prefix = `restate-proof-${randomUUID().slice(0, 8)}`
const proxy = `${prefix}-proxy`
const nodes = [0, 1, 2].map((index) => `${prefix}-${index}`)
const created: string[] = []
const events: Record<string, unknown>[] = []
const record = (event: Record<string, unknown>) => {
  events.push({ at: new Date().toISOString(), ...event })
  writeFileSync(`${directory}/events.json`, JSON.stringify(events, null, 2))
  console.log(JSON.stringify(event))
}
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const readLogs = (node: string, since?: string) => {
  const result = spawnSync('docker', ['logs', ...(since === undefined ? [] : ['--since', since]), node], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout + result.stderr
}
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const until = async (name: string, check: () => boolean, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (check()) return
    } catch (error) {
      lastError = error
    }
    await sleep(1000)
  }
  throw new Error(`${name} did not converge`, { cause: lastError })
}
const manifest = YAML.parse(
  readFileSync(new URL('../../../../argocd/applications/restate/statefulset.yaml', import.meta.url), 'utf8'),
)
const selectedSettings = new Set([
  'RESTATE_METADATA_SERVER__RAFT_ELECTION_TICK',
  'RESTATE_GOSSIP_FAILURE_THRESHOLD',
  'RESTATE_GOSSIP_LONELINESS_THRESHOLD',
  'RESTATE_GOSSIP_TIME_SKEW_THRESHOLD',
  'RESTATE_NETWORKING__CONNECT_TIMEOUT',
  'RESTATE_NETWORKING__HANDSHAKE_TIMEOUT',
  'RESTATE_NETWORKING__HTTP2_KEEP_ALIVE_TIMEOUT',
  'RESTATE_LOG_SERVER__ALWAYS_COMMIT_IN_BACKGROUND',
  'RESTATE_WORKER__STORAGE__ALWAYS_COMMIT_IN_BACKGROUND',
])
const settings = manifest.spec.template.spec.containers[0].env.filter((entry: { name: string }) =>
  selectedSettings.has(entry.name),
) as { name: string; value: string }[]
assert.equal(settings.length, selectedSettings.size)
const env = settings.flatMap(({ name, value }) => ['--env', `${name}=${value}`])
const ctl = (node: string, ...args: string[]) =>
  docker(
    'exec',
    node,
    'restatectl',
    '--yes',
    '--connect-timeout',
    '1000',
    '--request-timeout',
    '12000',
    '--address',
    'http://127.0.0.1:5122',
    ...args,
  )
const metadata = (node: string) =>
  ctl(node, 'metadata-server', 'list-servers')
    .split('\n')
    .map((line) =>
      line
        .replace(/[│┃║]/g, ' ')
        .trim()
        .split(/\s+/),
    )
    .filter((row) => /^N[123]$/.test(row[0] ?? '') && row[1] === 'Member')
const leader = (rows: string[][]) => {
  assert(rows.length >= 2)
  const selected = rows[0]?.[3]
  assert(selected && /^N[123]$/.test(selected))
  assert(rows.every((row) => row[1] === 'Member' && row[3] === selected && row[7] === rows[0]?.[7]))
  return { node: nodes[Number(selected.slice(1)) - 1] as string, id: selected, term: Number(rows[0]?.[7]) }
}
const query = (node: string) => {
  const result = docker(
    'exec',
    node,
    'curl',
    '--silent',
    '--show-error',
    '--fail-with-body',
    '--max-time',
    '20',
    '-H',
    'content-type: application/json',
    '-H',
    'accept: application/json',
    '--data',
    JSON.stringify({ query: 'SELECT COUNT(*) AS invocations FROM sys_invocation_status' }),
    'http://127.0.0.1:9070/query',
  )
  assert(!result.includes('No such scanner'))
  const decoded = JSON.parse(result)
  assert(Array.isArray(decoded.rows), `Unexpected query response: ${result}`)
}
const toxic = (node: string, method: string, path: string, body?: unknown) =>
  docker(
    'exec',
    node,
    'curl',
    '--silent',
    '--show-error',
    '--fail',
    '--max-time',
    '15',
    '-X',
    method,
    '-H',
    'content-type: application/json',
    ...(body === undefined ? [] : ['--data', JSON.stringify(body)]),
    `http://${proxy}:8474${path}`,
  )
const assertNoFalseDeaths = (since: string) => {
  for (const node of nodes) {
    const logs = readLogs(node, since)
    assert(!/declaring.*dead|peer.*declared.*dead/i.test(logs), `False peer death in ${node}`)
  }
}

try {
  const effectiveConfig = docker('run', '--rm', ...env, image, '--production', '--dump-config')
  writeFileSync(`${directory}/effective-config.toml`, effectiveConfig)
  const effective = Bun.TOML.parse(effectiveConfig)
  assert.equal(effective['gossip-tick-interval'], '100ms')
  assert.equal(effective['gossip-failure-threshold'], 450)
  assert.equal(effective['gossip-loneliness-threshold'], 600)
  assert.equal(effective['gossip-time-skew-threshold'], '5s')
  assert.deepEqual(effective['metadata-server']['raft-election-tick'], 450)
  for (const key of ['connect-timeout', 'handshake-timeout', 'http2-keep-alive-timeout'])
    assert.equal(effective.networking[key], '10s')
  assert.equal(effective['log-server']['always-commit-in-background'], true)
  assert.equal(effective.worker.storage['always-commit-in-background'], true)
  docker('network', 'create', '--label', 'lab.restate-proof=true', prefix)
  const config = nodes.map((node, index) => ({
    name: node,
    listen: `0.0.0.0:${15122 + index}`,
    upstream: `${node}:5122`,
    enabled: true,
  }))
  writeFileSync(`${directory}/proxy.json`, JSON.stringify(config))
  docker(
    'create',
    '--name',
    proxy,
    '--network',
    prefix,
    '--label',
    'lab.restate-proof=true',
    'ghcr.io/shopify/toxiproxy:2.12.0@sha256:9378ed52a28bc50edc1350f936f518f31fa95f0d15917d6eb40b8e376d1a214e',
    '-host',
    '0.0.0.0',
    '-config',
    '/proxies.json',
  )
  created.push(proxy)
  docker('cp', `${directory}/proxy.json`, `${proxy}:/proxies.json`)
  docker('start', proxy)
  const addresses = JSON.stringify(nodes.map((_, index) => `http://${proxy}:${15122 + index}`))
  for (const [index, node] of nodes.entries()) {
    docker(
      'run',
      '-d',
      '--name',
      node,
      '--network',
      prefix,
      '--label',
      'lab.restate-proof=true',
      '--memory',
      '2g',
      ...env,
      '--env',
      'RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE=256 MiB',
      '--env',
      'RESTATE_WORKER__INVOKER__MEMORY_LIMIT=128 MiB',
      '--env',
      `RESTATE_METADATA_CLIENT__ADDRESSES=${addresses}`,
      image,
      '--production',
      '--cluster-name',
      prefix,
      '--node-name',
      node,
      '--force-node-id',
      String(index + 1),
      '--bind-ip',
      '0.0.0.0',
      '--advertised-address',
      `http://${proxy}:${15122 + index}`,
      '--default-num-partitions',
      '1',
      '--auto-provision',
      String(index === 0),
      '--log-format',
      'json',
      '--log-disable-ansi-codes',
      'true',
    )
    created.push(node)
  }
  const first = nodes[0] as string
  await until('all three nodes', () => nodes.every((node) => ctl(first, 'nodes', 'list').includes(node)))
  ctl(first, 'metadata-server', 'add-node', 'N2,N3')
  await until('three-member metadata quorum', () => {
    const rows = metadata(first)
    leader(rows)
    return rows.length === 3 && rows.every((row) => row[4] === '[N1,N2,N3]')
  })
  ctl(first, 'config', 'set', '--replication', '2')
  await until('distributed SQL', () => {
    query(first)
    return true
  })
  const initial = leader(metadata(first))
  record({ phase: 'healthy', ...initial, settings })
  const observer = nodes.find((node) => node !== initial.node) as string
  const sinceDelay = new Date().toISOString()
  for (const stream of ['upstream', 'downstream'])
    toxic(observer, 'POST', `/proxies/${initial.node}/toxics`, {
      name: stream,
      type: 'latency',
      stream,
      attributes: { latency: 3000, jitter: 0 },
    })
  record({ phase: 'messages-delayed', oneWayLatencyMs: 3000 })
  await sleep(15_000)
  assert.deepEqual(leader(metadata(observer)), initial)
  query(observer)
  for (const stream of ['upstream', 'downstream'])
    toxic(observer, 'DELETE', `/proxies/${initial.node}/toxics/${stream}`)
  await sleep(3000)
  assertNoFalseDeaths(sinceDelay)
  record({ phase: 'messages-recovered', ...leader(metadata(observer)) })
  const sincePause = new Date().toISOString()
  docker('pause', initial.node)
  record({ phase: 'process-paused', durationMs: 38_000, node: initial.node })
  await sleep(38_000)
  docker('unpause', initial.node)
  await until('same quorum after pause', () => {
    const members = metadata(observer)
    assert.deepEqual(leader(members), initial)
    return members.length === 3
  })
  assertNoFalseDeaths(sincePause)
  query(observer)
  record({ phase: 'pause-recovered', ...leader(metadata(observer)) })
  const failedAt = Date.now()
  docker('kill', initial.node)
  record({ phase: 'node-killed', node: initial.node })
  let elected = initial
  await until(
    'replacement leader after actual node loss',
    () => {
      elected = leader(metadata(observer))
      return elected.id !== initial.id && elected.term > initial.term
    },
    100_000,
  )
  const detectionMs = Date.now() - failedAt
  assert(detectionMs < 100_000)
  await until('SQL after node loss', () => {
    query(observer)
    return true
  })
  record({ phase: 'passed', detectionMs, elected })
} finally {
  for (const node of created) {
    try {
      writeFileSync(`${directory}/${node}.log`, readLogs(node))
    } catch (error) {
      record({ phase: 'log-collection-failed', node, error: String(error) })
    }
    try {
      docker('rm', '-f', '-v', node)
    } catch (error) {
      record({ phase: 'cleanup-failed', node, error: String(error) })
    }
  }
  try {
    docker('network', 'rm', prefix)
  } catch (error) {
    record({ phase: 'network-cleanup-failed', error: String(error) })
  }
}
