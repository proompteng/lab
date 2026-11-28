import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import * as grpc from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'
import { REQUIRED_CRDS } from '../kube/fleet'
import { STEP_INDEX } from '../kube/runs'

const entry = resolve(import.meta.dir, '../index.ts')
let directory: string
let env: NodeJS.ProcessEnv

beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'agentctl-effect4-'))
  env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTCTL_') && !key.startsWith('AGENTS_GRPC_')),
  )
  env.XDG_CONFIG_HOME = directory
  env.NO_COLOR = '1'
  env.PATH = `${directory}:${env.PATH}`
  env.AGENTCTL_FIXTURE_ARGS = resolve(directory, 'kubectl-args')
  const kubectl = resolve(directory, 'kubectl')
  await writeFile(
    kubectl,
    `#!/bin/sh
if [ -n "$AGENTCTL_FIXTURE_RESPONSES" ]; then
  exec "${process.execPath}" "${resolve(directory, 'kubectl-fixture.ts')}" "$@"
fi
printf '%s\\n' "$@" > "$AGENTCTL_FIXTURE_ARGS"
printf '%s\\n' '{"items":[],"metadata":{"name":"fixture"}}'
`,
  )
  await writeFile(
    resolve(directory, 'kubectl-fixture.ts'),
    String.raw`
import { appendFileSync, readFileSync } from 'node:fs'
const fixture = JSON.parse(readFileSync(process.env.AGENTCTL_FIXTURE_RESPONSES, 'utf8'))
const raw = process.argv.slice(2)
const args = [...raw]
while (['--kubeconfig', '--context', '-n'].includes(args[0])) args.splice(0, 2)
const [verb, resource] = args
const manifest = verb === 'create' ? JSON.parse(await Bun.stdin.text()) : undefined
appendFileSync(process.env.AGENTCTL_FIXTURE_TRACE, JSON.stringify({ args: raw, manifest }) + '\n')
if (manifest) {
  const trace = process.env.AGENTCTL_FIXTURE_TRACE
  const name = manifest.metadata.name ?? 'verification'
  const dryRun = args.includes('--dry-run=server')
  const error = fixture[(dryRun ? 'dry-run ' : 'create ') + name]?.error
  if (error) {
    console.error(error)
    process.exit(1)
  }
  if (!dryRun && fixture.parallelCreates) {
    const realCreates = () => readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(({ args, manifest }) => manifest && !args.includes('--dry-run=server')).length
    const deadline = Date.now() + 1000
    while (realCreates() < fixture.parallelCreates && Date.now() < deadline) await Bun.sleep(10)
    if (realCreates() < fixture.parallelCreates) process.exit(1)
    appendFileSync(trace, JSON.stringify({ args: raw, completed: name }) + '\n')
  }
  console.log(JSON.stringify({ ...manifest, metadata: { ...manifest.metadata, name, uid: name + '-uid' } }))
} else if (verb === 'delete') {
  console.log('job deleted')
} else if (verb === 'logs') {
  const response = fixture[verb + ' ' + resource]
  if (response?.error) {
    console.error(response.error)
    process.exit(1)
  }
  console.log(response ?? 'runner fixture log')
} else {
  const field = args[args.indexOf('--field-selector') + 1]
  const response = fixture[verb + ' ' + resource + ' ' + field] ?? fixture[verb + ' ' + resource]
  if (response && response.error) {
    console.error(response.error)
    process.exit(1)
  } else if (response) {
    console.log(JSON.stringify(response))
  } else if (!args.includes('--ignore-not-found')) {
    console.error('unexpected kubectl call: ' + verb + ' ' + resource)
    process.exit(1)
  }
}
`,
  )
  await chmod(kubectl, 0o755)
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

const run = async (args: string[], overrides?: NodeJS.ProcessEnv) => {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: { ...env, ...overrides },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 4000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timeout)
    child.kill()
  }
}

describe('Effect CLI entry point', () => {
  it('shows help and preserves validation exit codes', async () => {
    for (const args of [['--help'], ['help', 'all'], ['run', '--help']]) {
      const result = await run(args)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('agentctl')
      expect(result.stdout).toContain('--namespace')
      expect(result.stdout.match(/^GLOBAL FLAGS$/gim)).toHaveLength(1)
      expect(result.stdout).toMatch(/^DESCRIPTION$/m)
      expect(result.stdout).toMatch(/--context.*Use this kubeconfig context/)
      expect(result.stdout).not.toMatch(/^  (create|init|list|run|submit|wait|logs|cancel|codex)\s*$/m)
    }
    const submitHelp = await run(['run', 'submit', '--help'])
    expect(submitHelp.stdout).toMatch(/--prompt-file.*Read the inline task text/)
    expect(submitHelp.stdout).toMatch(/--verify.*Confirm the rendered prompt/)
    expect(submitHelp.stdout.match(/^GLOBAL FLAGS$/gim)).toHaveLength(1)
    for (const args of [['not-a-command'], ['run', 'submit'], ['get', 'agent', '--unknown']]) {
      const result = await run(args)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('USAGE')
    }
  })

  it('discovers fleet run commands and rejects invalid batch concurrency before reading the spec', async () => {
    const help = await run(['help', 'run'])
    expect(help.stdout).toContain('run summary <name> [--json]')
    expect(help.stdout).toContain('run batch --spec')
    const result = await run(['run', 'batch', '--spec', '/missing/file', '--concurrency', '0'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--concurrency must be a positive integer')
  })

  it('defaults absent boolean flags to false and preserves repeated values', async () => {
    expect(await run(['config', 'view'])).toEqual({ exitCode: 0, stdout: '{}\n', stderr: '' })
    const result = await run([
      'init',
      'impl',
      '--text',
      'hello',
      '--summary',
      'fixture',
      '--source',
      'provider=test',
      '--acceptance',
      'first',
      '--criteria',
      'second',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('kind: ImplementationSpec')
    expect(result.stdout).toContain('    - first\n    - second')
  })

  it('uses the same global flags to save config without shadowed local flags', async () => {
    const overrides = { XDG_CONFIG_HOME: resolve(directory, 'config-fixture') }
    const result = await run(['config', 'set', '-n', 'fixture', '--context', 'galactic-fixture', '--no-tls'], overrides)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse((await run(['config', 'view'], overrides)).stdout)).toEqual({
      namespace: 'fixture',
      context: 'galactic-fixture',
      tls: false,
    })
    expect((await run(['config', 'set', '--context', 'new-fixture'], overrides)).exitCode).toBe(0)
    expect(JSON.parse((await run(['config', 'view'], overrides)).stdout)).toEqual({
      namespace: 'fixture',
      context: 'new-fixture',
      tls: false,
    })
  })

  it('generates and installs completion scripts', async () => {
    for (const shell of ['bash', 'zsh', 'fish']) {
      const result = await run(['completion', shell])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('agentctl')
    }
    expect((await run(['completion', 'install', 'zsh'])).exitCode).toBe(0)
    expect(await readFile(resolve(directory, 'agentctl/completions/agentctl.zsh'), 'utf8')).toContain(
      '#compdef agentctl',
    )
    expect((await run(['completion', 'unknown'])).exitCode).toBe(2)
  })

  it('executes Kubernetes commands through kubectl', async () => {
    const result = await run(['get', 'agent', '--namespace', 'fixture', '--output', 'json'])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ items: [], metadata: { name: 'fixture' } })
    expect((await readFile(resolve(directory, 'kubectl-args'), 'utf8')).trim().split('\n')).toEqual([
      '-n',
      'fixture',
      'get',
      'agents.agents.proompteng.ai',
      '-o',
      'json',
    ])
  })

  it('executes gRPC commands and closes the client', async () => {
    const definition = loadSync(resolve(import.meta.dir, '../../proto/proompteng/agents/v1/agentctl.proto'), {
      keepCase: true,
    })
    const service = definition['proompteng.agents.v1.AgentctlService']
    if (!service || !('GetServerInfo' in service)) throw new Error('Missing AgentctlService definition')
    const server = new grpc.Server()
    server.addService(service, {
      GetServerInfo: (_call: unknown, callback: grpc.sendUnaryData<unknown>) => callback(null, { version: 'fixture' }),
    })
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
          if (error) reject(error)
          else resolve(port)
        })
      })
      const result = await run(['--grpc', '--server', `127.0.0.1:${port}`, 'version'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('server fixture')
    } finally {
      server.forceShutdown()
    }
  })

  it('interrupts a long watch without waiting for the polling interval', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const child = Bun.spawn([process.execPath, entry, 'watch', 'agent', '--interval', '60', '--output', 'json'], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 4000)
      try {
        const reader = child.stdout.getReader()
        const output = await reader.read()
        expect(new TextDecoder().decode(output.value)).toContain('items')
        child.kill(signal)
        expect(await child.exited).toBe(0)
        reader.releaseLock()
      } finally {
        clearTimeout(timeout)
        child.kill()
      }
    }
  })
})

const agentRuns = 'agentruns.agents.proompteng.ai'
const runLabel = 'agents.proompteng.ai/agent-run'
const runUid = 'agents.proompteng.ai/run-uid'
const account = 'codex-auto-ontology-runner'
const audience = 'agents.proompteng.ai/auto-ontology-mcp'
const mountPath = '/var/run/secrets/agents-auto-ontology-mcp'
const promptText = 'Verify the fixture workflow.'
const fixtureRun = (name: string, phase: string, date: string) => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: { name, uid: `${name}-uid`, namespace: 'fixture', creationTimestamp: date },
  spec: {
    agentRef: { name: 'codex-agent' },
    runtime: { type: 'job' },
    parameters: { head: `codex/${name}` },
  },
  status: { phase, conditions: [{ type: 'Ready', status: 'False', reason: 'WaitingForController' }] },
})
const fixtureJob = (name: string, suffix: string, status: object, uid = `${name}-uid`) => ({
  metadata: {
    name: `${name}-${suffix}`,
    uid: `${name}-${suffix}-uid`,
    labels: { [runLabel]: name, [runUid]: uid },
  },
  status,
})
const stale = fixtureRun('finished', 'Pending', '2026-07-01T00:00:00Z')
const queued = fixtureRun('queued', 'Pending', '2026-07-03T00:00:00Z')
const running = fixtureRun('running', 'Running', '2026-07-02T00:00:00Z')
const done = fixtureJob('finished', 'job', { conditions: [{ type: 'Complete', status: 'True' }] })
const active = fixtureJob('running', 'job', { active: 1 })
const livePod = {
  metadata: {
    name: 'running-pod',
    uid: 'running-pod-uid',
    labels: { 'batch.kubernetes.io/job-name': active.metadata.name, [runLabel]: 'running', [runUid]: 'running-uid' },
  },
  spec: {
    nodeName: 'node-arm',
    serviceAccountName: account,
    containers: [{ name: 'sidecar' }, { name: 'agent-runner' }],
  },
  status: { phase: 'Running' },
}

const baseFixture = {
  [`get ${agentRuns}`]: { items: [stale, queued, running] },
  [`get ${agentRuns}/finished`]: stale,
  [`get ${agentRuns}/queued`]: queued,
  [`get ${agentRuns}/running`]: running,
  'get jobs.batch': { items: [done, active] },
  'get pods': { items: [livePod] },
}

const fixture = async (name: string, data: Record<string, unknown>) => {
  const file = resolve(directory, `${name}.json`)
  const trace = resolve(directory, `${name}-trace`)
  await writeFile(file, JSON.stringify(data))
  await writeFile(trace, '')
  return {
    run: (args: string[]) =>
      run(['-n', 'fixture', '--context', 'galactic-fixture', ...args], {
        AGENTCTL_FIXTURE_RESPONSES: file,
        AGENTCTL_FIXTURE_TRACE: trace,
      }),
    requests: async () =>
      (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line): { args: string[]; manifest?: Record<string, unknown>; completed?: string } => JSON.parse(line)),
  }
}

describe('Kubernetes fleet operations', () => {
  it('summarizes the selected runner container without printing raw log lines or credentials', async () => {
    const text = 'Opened https://github.com/owner/repo/pull/7.\nBearer fixture-log-token'
    const status = { status: 'succeeded', model: 'gpt-test', effort: 'high', result: { text, truncated: false } }
    const client = await fixture('summary', {
      ...baseFixture,
      [`get ${agentRuns}/running`]: {
        ...running,
        status: {
          phase: 'Succeeded',
          startedAt: '2026-07-02T00:00:00Z',
          finishedAt: '2026-07-02T00:00:02.500Z',
          vcs: { baseBranch: 'main', headBranch: 'codex/actual-head' },
        },
      },
      'get pods': {
        items: [
          {
            ...livePod,
            status: {
              phase: 'Succeeded',
              containerStatuses: [{ name: 'agent-runner', state: { terminated: { message: JSON.stringify(status) } } }],
            },
          },
        ],
      },
      'logs pod/running-pod': [
        'raw opaque secret from setup',
        JSON.stringify({
          event: {
            type: 'usage',
            usage: { inputTokens: 8, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 1 },
          },
        }),
      ].join('\n'),
    })
    const result = await client.run(['run', 'summary', 'running', '--json'])
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('fixture-log-token')
    expect(result.stdout).not.toContain('raw opaque secret')
    expect(JSON.parse(result.stdout)).toMatchObject({
      phase: 'Succeeded',
      node: 'node-arm',
      base: 'main',
      head: 'codex/actual-head',
      logStatus: 'available',
      durationMs: 2500,
      model: 'gpt-test',
      effort: 'high',
      usage: { input: 8, cached: 0, output: 3, reasoning: 1 },
      prUrls: ['https://github.com/owner/repo/pull/7'],
      assistantMessageComplete: true,
      assistantMessage: 'Opened https://github.com/owner/repo/pull/7.\n[redacted authorization]',
    })
    expect((await client.requests()).at(-1)?.args.slice(4)).toEqual(['logs', 'pod/running-pod', '-c', 'agent-runner'])
    const pending = await client.run(['run', 'summary', 'queued'])
    expect(pending.exitCode).toBe(0)
    expect(pending.stdout).toMatch(/Logs:\s+no-runner-pod/)
    expect(pending.stdout).toContain('No assistant message available.')
  })

  it('fails summary on a denied Pod log read without printing kubectl stderr', async () => {
    const client = await fixture('summary-denied', {
      ...baseFixture,
      'logs pod/running-pod': { error: 'Forbidden: opaque-sensitive-server-error' },
    })
    const result = await client.run(['run', 'summary', 'running', '--json'])
    expect(result).toEqual({
      exitCode: 3,
      stdout: '',
      stderr: 'Could not read runner logs for AgentRun running (Forbidden); see agentctl describe run running.\n',
    })
  })

  it('shares workload joins, sorting, filters, and raw JSON across run lists', async () => {
    const client = await fixture('listing', baseFixture)
    const table = await client.run(['run', 'list', '-o', 'wide'])
    expect(table.exitCode, table.stderr).toBe(0)
    expect(table.stderr).toBe('')
    const rows = table.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
    expect(rows[0]).toEqual(['NAME', 'AGENT', 'PHASE', 'POD_PHASE', 'NODE', 'HEAD', 'AGE', 'SA', 'DESYNC', 'JOB'])
    expect(rows.slice(1).map(([name]) => name)).toEqual(['queued', 'running', 'finished'])
    expect(rows[2]).toContain('node-arm')
    expect(rows[2]).toContain('codex/running')
    expect(rows[2]).toContain(account)
    expect(rows[3]).toContain('Pending->Succeeded')
    expect((await client.requests()).map(({ args }) => args[5]).sort()).toEqual(
      [agentRuns, 'jobs.batch', 'pods'].sort(),
    )

    const filtered = await client.run(['list', 'run', '--stale', '-o', 'json'])
    expect(filtered.exitCode).toBe(0)
    expect(filtered.stderr).toBe('')
    expect(JSON.parse(filtered.stdout)).toEqual({ items: [stale] })
    const activeRuns = await client.run(['get', 'runs', '--active', '--sort-by', 'phase', '--limit', '1', '-o', 'json'])
    expect(activeRuns.exitCode).toBe(0)
    expect(JSON.parse(activeRuns.stdout)).toEqual({ items: [queued] })
    const sorted = await client.run(['run', 'list', '--sort-by', 'name', '-o', 'json'])
    expect(JSON.parse(sorted.stdout)).toEqual({ items: [stale, queued, running] })

    expect((await client.run(['list', 'run', '--limit', '0'])).exitCode).toBe(2)
    expect((await client.run(['get', 'agent', '--active'])).exitCode).toBe(2)
  }, 10_000)

  it('reports health separately from remediation and exposes capacity without dumping deployment env', async () => {
    const deploy = (name: string, ready = 1) => ({
      metadata: { name, generation: 4 },
      spec: { replicas: 1 },
      status: { readyReplicas: ready, availableReplicas: ready, observedGeneration: 4 },
    })
    const controllers = {
      ...deploy('agents-controllers'),
      spec: {
        ...deploy('agents-controllers').spec,
        template: {
          spec: {
            containers: [
              {
                name: 'agents-controllers',
                env: [
                  { name: 'DATABASE_URL', value: 'omitted-from-output' },
                  { name: 'AGENTS_CONTROLLER_CONCURRENCY_CLUSTER', value: '160' },
                  { name: 'AGENTS_CONTROLLER_RATE_NAMESPACE', value: '240' },
                  { name: 'AGENTS_CONTROLLER_RATE_REPO', valueFrom: { configMapKeyRef: { name: 'cfg', key: 'rate' } } },
                  { name: 'AGENTS_LEADER_ELECTION_LEASE_NAME', value: 'leader-fixture' },
                  { name: 'AGENTS_LEADER_ELECTION_LEASE_NAMESPACE', value: 'leases' },
                ],
              },
            ],
          },
        },
      },
    }
    const client = await fixture('capacity', {
      ...baseFixture,
      'get namespace/fixture': { metadata: { name: 'fixture' } },
      'get deployment': { items: [deploy('agents'), controllers, deploy('agents-shell', 0)] },
      'get crd': {
        items: REQUIRED_CRDS.filter(
          (name) => !name.startsWith('versioncontrolproviders') && !name.startsWith('swarms'),
        ).map((name) => ({ metadata: { name }, status: { conditions: [{ type: 'Established', status: 'True' }] } })),
      },
      'get leases.coordination.k8s.io': {
        items: [
          {
            metadata: { name: 'leader-fixture' },
            spec: { holderIdentity: 'controller-1', renewTime: '2026-07-01T00:00:00Z', leaseDurationSeconds: 60 },
          },
        ],
      },
      'get clusters.postgresql.cnpg.io/agents-db-next': {
        metadata: { name: 'agents-db-next' },
        spec: { instances: 2 },
        status: { phase: 'Cluster in healthy state', readyInstances: 2 },
      },
      'get nodes': {
        items: [
          {
            metadata: { name: 'node-arm' },
            status: { nodeInfo: { architecture: 'arm64' }, allocatable: { cpu: '16', memory: '64Gi', pods: '250' } },
          },
        ],
      },
    })

    const status = await client.run(['status'])
    expect(status.exitCode).toBe(0)
    for (const label of [
      'deployment/agents',
      'deployment/agents-controllers',
      'deployment/agents-shell',
      'deployment/agents-auto-ontology-mcp-gateway',
      'agents-db-next',
      'controller-1',
      'renewTime',
      '18/20',
      'versioncontrolproviders.agents.proompteng.ai',
      'swarms.swarm.proompteng.ai',
      '1 stale',
      'RUNNING_PODS',
      'node-arm',
    ]) {
      expect(status.stdout).toContain(label)
    }
    expect(status.stdout).not.toContain('Remediation:')
    const details = await client.run(['diagnose', '-o', 'json'])
    expect(details.exitCode).toBe(0)
    const diagnose = JSON.parse(details.stdout)
    expect(diagnose.crds).toHaveLength(20)
    expect(diagnose.hints.join(' ')).toContain('run list --stale')
    expect(diagnose.hints.join(' ')).toContain('GitOps CRD sync')
    expect(diagnose.hints.join(' ')).toContain('kubectl -n leases describe lease/leader-fixture')
    expect(diagnose.hints.join(' ')).toContain('describe deployment/agents-shell')
    const capacity = await client.run(['capacity'])
    expect(capacity.exitCode).toBe(0)
    expect(capacity.stdout).toContain('3 total, 2 active, 1 pending, 1 stale')
    expect(capacity.stdout).toMatch(/node-arm\s+1\s+arm64\s+1\s+250\s+16\s+64Gi/)
    expect(capacity.stdout).toMatch(/AGENTS_CONTROLLER_CONCURRENCY_CLUSTER\s+160/)
    expect(capacity.stdout).toMatch(/AGENTS_CONTROLLER_RATE_REPO\s+\(valueFrom\)/)
    expect(capacity.stdout).not.toContain('omitted-from-output')
  }, 10_000)

  it('does not report forbidden CRD or workload reads as absent resources or zero counts', async () => {
    const client = await fixture('denied', {
      ...baseFixture,
      'get jobs.batch': { error: 'Error from server (Forbidden)' },
      'get crd': { error: 'Error from server (Forbidden)' },
    })
    const result = await client.run(['diagnose', '-o', 'json'])
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(result.stdout)
    expect(body.runs).toBeNull()
    expect(body.crds.every((crd: { status: string }) => crd.status === 'unknown')).toBe(true)
    expect(body.unavailable).toContain('jobs: access forbidden')
    expect(body.hints.join(' ')).toContain('kubectl auth can-i')
  })

  it('finishes a stale Pending run from its completed Job, without changing raw CR JSON', async () => {
    const client = await fixture('wait', baseFixture)
    const result = await client.run(['run', 'wait', 'finished', '--timeout', '1s', '--interval', '50ms', '-o', 'json'])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(stale)
    expect(result.stderr).toContain('Job finished-job indicates Succeeded; CR phase is still Pending')
    expect(await client.requests()).toHaveLength(3)
    const timeout = await client.run(['run', 'wait', 'queued', '--timeout', '100ms', '--interval', '25ms'])
    expect(timeout.exitCode).toBe(3)
    expect(timeout.stderr).toContain('Timed out waiting for AgentRun queued')
  })

  it('passes pod log flags and cancels only live jobs for the current run UID', async () => {
    const client = await fixture('actions', {
      ...baseFixture,
      'get jobs.batch': {
        items: [
          active,
          done,
          fixtureJob('running', 'older', { succeeded: 1 }),
          fixtureJob('running', 'recycled', { active: 1 }, 'old-uid'),
        ],
      },
    })
    const logs = await client.run([
      'run',
      'logs',
      'running',
      '-f',
      '--tail',
      '25',
      '--since',
      '10m',
      '--timestamps',
      '--previous',
    ])
    expect(logs.exitCode, logs.stderr).toBe(0)
    expect(logs.stdout).toBe('runner fixture log\n')
    expect((await client.requests()).at(-1)?.args.slice(4)).toEqual([
      'logs',
      'pod/running-pod',
      '-c',
      'agent-runner',
      '-f',
      '--tail=25',
      '--since=10m',
      '--timestamps',
      '--previous',
    ])
    const cancel = await client.run(['run', 'cancel', 'running'])
    expect(cancel.exitCode).toBe(0)
    expect(cancel.stdout).toContain('Requested cancellation of 1 Job(s)')
    const noOp = await client.run(['run', 'cancel', 'finished'])
    expect(noOp.stdout).toContain('no live Jobs to cancel')
    expect(
      (await client.requests()).filter(({ args }) => args[4] === 'delete').map(({ args }) => args.slice(4)),
    ).toEqual([['delete', '--ignore-not-found', '--wait=false', 'job/running-job']])
  })
})

describe('AgentRun prompt and verification boundary', () => {
  const verificationRun = fixtureRun('verification', 'Running', '2026-07-01T00:00:00Z')
  const podSpec = {
    ...livePod.spec,
    containers: [
      {
        name: 'agent-runner',
        env: [{ name: 'AGENTS_MCP_IDENTITY_TOKEN_PATH', value: `${mountPath}/token` }],
        volumeMounts: [
          { name: 'mcp', mountPath, readOnly: true },
          { name: 'spec', mountPath: '/workspace/run.json', subPath: 'run.json' },
        ],
      },
    ],
    volumes: [
      { name: 'mcp', projected: { sources: [{ serviceAccountToken: { audience, path: 'token' } }] } },
      { name: 'spec', configMap: { name: 'verification-spec-step-1-attempt-1' } },
    ],
  }
  const data = {
    [`get ${agentRuns}/verification`]: verificationRun,
    'get agents.agents.proompteng.ai/codex-agent': { spec: { providerRef: { name: 'codex' } } },
    'get agentproviders.agents.proompteng.ai/codex': {
      spec: { workload: { serviceAccountName: account, serviceAccountToken: { audience, mountPath } } },
    },
    'get jobs.batch': { items: [fixtureJob('verification', 'job', { active: 1 })] },
    'get pods': {
      items: [
        {
          ...livePod,
          metadata: {
            name: 'verification-pod',
            uid: 'verification-pod-uid',
            labels: { [runLabel]: 'verification', [runUid]: 'verification-uid', 'job-name': 'verification-job' },
          },
          spec: podSpec,
        },
      ],
    },
    'get configmap/verification-spec-step-1-attempt-1': {
      metadata: { name: 'verification-spec-step-1-attempt-1' },
      data: { 'run.json': JSON.stringify({ prompt: promptText, ignored: 'unprinted-payload' }) },
    },
    'get events': { items: [] },
    'get events involvedObject.uid=verification-pod-uid': {
      items: [
        {
          metadata: { name: 'scheduled' },
          involvedObject: { kind: 'Pod', name: 'verification-pod', uid: 'verification-pod-uid' },
          reason: 'Scheduled',
          message: 'Assigned to node-arm',
          type: 'Normal',
          lastTimestamp: '2026-07-01T00:00:01Z',
        },
      ],
    },
  }

  const batchRun = (name: string, text = promptText) => ({
    ...fixtureRun(name, 'Running', '2026-07-01T00:00:00Z'),
    metadata: { name },
    status: undefined,
    spec: { ...verificationRun.spec, parameters: { head: `codex/${name}` }, implementation: { inline: { text } } },
  })

  it('preflights the entire batch before creating any runs', async () => {
    const client = await fixture('batch-invalid', { 'dry-run bad': { error: 'Invalid: opaque-admission-value' } })
    const file = resolve(directory, 'batch-invalid-manifests.json')
    const first = batchRun('first')
    const bad = batchRun('bad')
    for (const [spec, message] of [
      [{ ...bad.spec, parameters: first.spec.parameters }, 'duplicate head branch'],
      [
        { ...bad.spec, runtime: { type: 'job', config: { serviceAccountName: 'overridden' } } },
        'serviceAccountName overrides are forbidden',
      ],
      [{ ...bad.spec, implementation: undefined }, 'provide a prompt'],
    ] as const) {
      await writeFile(file, JSON.stringify([first, { ...bad, spec }]))
      const result = await client.run(['run', 'batch', '--spec', file])
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain(message)
    }
    expect(await client.requests()).toEqual([])
    await writeFile(file, JSON.stringify([first, bad]))
    const result = await client.run(['run', 'batch', '--spec', file, '--concurrency', '1'])
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('Kubernetes dry-run rejected the manifest (Invalid); no runs submitted')
    expect(result.stderr).not.toContain('opaque-admission-value')
    expect((await client.requests()).map(({ args }) => args.includes('--dry-run=server'))).toEqual([true, true])
  }, 10_000)

  it('dispatches at the requested concurrency after preflight and keeps result order', async () => {
    const client = await fixture('batch-dispatch', { ...baseFixture, parallelCreates: 2 })
    const file = resolve(directory, 'batch-dispatch-manifests.json')
    await writeFile(file, JSON.stringify(['running', 'second', 'third'].map((name) => batchRun(name))))
    const result = await client.run(['run', 'batch', '--spec', file, '--concurrency', '2'])
    expect(result.exitCode, result.stderr).toBe(0)
    expect(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/)),
    ).toEqual([
      ['ENTRY', 'NAME', 'NODE', 'STATUS'],
      ['1', 'running', 'node-arm', 'Submitted'],
      ['2', 'second', '-', 'Submitted'],
      ['3', 'third', '-', 'Submitted'],
    ])
    const requests = await client.requests()
    expect(requests.slice(0, 3).every(({ args }) => args.includes('--dry-run=server'))).toBe(true)
    expect(
      requests
        .slice(3, 9)
        .map(({ manifest }) => (manifest ? 'start' : 'end'))
        .slice(0, 3),
    ).toEqual(['start', 'start', 'end'])
    expect(requests.filter(({ manifest, args }) => manifest && !args.includes('--dry-run=server'))).toHaveLength(3)
    expect(requests.at(-1)?.args.slice(4)).toEqual(['get', 'pods', '-o', 'json', '-l', runLabel])
  })

  it('verifies each submitted run and reports successful creates even when another fails verification', async () => {
    const workflow = batchRun('verification', 'First workflow step.')
    const workflowRun = {
      ...workflow,
      spec: {
        ...workflow.spec,
        runtime: { type: 'workflow' },
        workflow: { steps: [{ name: 'first' }, { name: 'second', implementation: { inline: { text: promptText } } }] },
      },
    }
    const mismatch = fixtureRun('mismatch', 'Running', '2026-07-01T00:00:00Z')
    const verificationPod = data['get pods'].items[0]
    const client = await fixture('batch-verify', {
      ...data,
      [`get ${agentRuns}/verification`]: { ...verificationRun, spec: workflowRun.spec },
      [`get ${agentRuns}/mismatch`]: mismatch,
      'get jobs.batch': { items: [...data['get jobs.batch'].items, fixtureJob('mismatch', 'job', { active: 1 })] },
      'get pods': {
        items: [
          {
            ...verificationPod,
            metadata: {
              ...verificationPod.metadata,
              labels: { ...verificationPod.metadata.labels, [STEP_INDEX]: '2' },
            },
          },
          {
            metadata: {
              name: 'mismatch-pod',
              labels: { [runLabel]: 'mismatch', [runUid]: 'mismatch-uid', 'job-name': 'mismatch-job' },
            },
            spec: podSpec,
          },
        ],
      },
    })
    const file = resolve(directory, 'batch-verify-manifests.json')
    await writeFile(file, JSON.stringify([workflowRun, batchRun('mismatch', 'different-prerequisite')]))
    const result = await client.run(['run', 'batch', '--spec', file, '--verify', '-o', 'json'])
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('Submitted AgentRun fixture/mismatch')
    expect(result.stderr).toContain('run.json.prompt does not match the task text')
    expect(result.stderr).not.toContain('different-prerequisite')
    expect(JSON.parse(result.stdout).runs).toEqual([
      { entry: 1, name: 'verification', node: 'node-arm', status: 'Verified' },
      { entry: 2, name: 'mismatch', node: 'node-arm', status: 'Verification failed' },
    ])
    const requests = await client.requests()
    expect(requests.filter(({ manifest, args }) => manifest && !args.includes('--dry-run=server'))).toHaveLength(2)
    expect(requests.filter(({ args }) => args[5] === 'agents.agents.proompteng.ai/codex-agent')).toHaveLength(1)
  })

  it('rejects prompt overrides before local Codex, filesystem reads, or kubectl', async () => {
    const client = await fixture('rejected', {})
    const variants = [
      ['run', 'submit', '--agent', 'codex-agent', '--runtime', 'job', '--prompt-file', '/missing/task'],
      ['run', 'codex', '--prompt-file', '/missing/task'],
      ['init', 'run', '--apply'],
    ]
    for (const args of variants) {
      const result = await client.run([...args, '--param', 'prompt=not-a-parameter'])
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('--param prompt=... is not supported')
    }
    expect(await client.requests()).toEqual([])
  })

  it('submits a literal prompt file and confirms provider identity and mounted workload evidence', async () => {
    const client = await fixture('verified', data)
    const file = resolve(directory, 'task.md')
    await writeFile(file, `${promptText}\n`)
    const result = await client.run([
      'run',
      'codex',
      '--prompt-file',
      file,
      '--repo',
      'owner/project',
      '--base',
      'main',
      '--head',
      'codex/branch',
      '--memory-request',
      '1Gi',
      '--memory-limit',
      '2Gi',
      '--ttl',
      '0',
      '--secret',
      'allowed-one',
      '--secret',
      'allowed-two',
      '--verify',
      '-o',
      'json',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('Verified AgentRun verification')
    expect(result.stderr).not.toContain(promptText)
    const body = JSON.parse(result.stdout)
    expect(body.spec).toEqual({
      agentRef: { name: 'codex-agent' },
      implementation: { inline: { text: `${promptText}\n` } },
      parameters: { repository: 'owner/project', base: 'main', head: 'codex/branch' },
      runtime: { type: 'workflow' },
      workflow: { steps: [{ name: 'implement' }] },
      ttlSecondsAfterFinished: 0,
      secrets: ['allowed-one', 'allowed-two'],
      workload: { resources: { requests: { memory: '1Gi' }, limits: { memory: '2Gi' } } },
    })
    expect((await client.requests()).filter(({ manifest }) => manifest).map(({ manifest }) => manifest?.kind)).toEqual([
      'AgentRun',
    ])
  })

  it('reports a verification mismatch without exposing the rendered prompt or retrying create', async () => {
    const client = await fixture('verify-mismatch', data)
    const result = await client.run([
      'run',
      'submit',
      '--agent',
      'codex-agent',
      '--runtime',
      'job',
      '--inline-prompt',
      'different task',
      '--verify',
    ])
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('Submitted AgentRun fixture/verification')
    expect(result.stderr).toContain('run.json.prompt does not match the task text')
    expect(result.stderr).not.toContain(promptText)
    expect((await client.requests()).filter(({ manifest }) => manifest)).toHaveLength(1)
  })

  it('renders parameterized ImplementationSpec placeholders before verifying run.json.prompt', async () => {
    const renderedPrompt = 'Compile owner/project on codex/branch for #42'
    const implData = {
      ...data,
      'get implementationspecs.agents.proompteng.ai/parameterized-impl': {
        spec: {
          text: 'Compile ${repository} on {{parameters.head}} for #${issueNumber}',
          source: { provider: 'github', externalId: 'owner/project#42' },
        },
      },
      'get configmap/verification-spec-step-1-attempt-1': {
        metadata: { name: 'verification-spec-step-1-attempt-1' },
        data: { 'run.json': JSON.stringify({ prompt: renderedPrompt }) },
      },
    }
    const client = await fixture('verify-parameterized-impl', implData)
    const result = await client.run([
      'run',
      'submit',
      '--agent',
      'codex-agent',
      '--impl',
      'parameterized-impl',
      '--runtime',
      'job',
      '--repo',
      'owner/project',
      '--head',
      'codex/branch',
      '--verify',
      '-o',
      'json',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('Verified AgentRun verification')
  })

  it('describes workload identity, mounted prompt and scoped Events but keeps -o json/yaml raw', async () => {
    const client = await fixture('description', data)
    const result = await client.run(['describe', 'run', 'verification'])
    expect(result.exitCode).toBe(0)
    for (const detail of [
      'Running',
      'WaitingForController',
      'verification-job',
      'verification-pod',
      'node-arm',
      account,
      'projected into agent-runner',
      promptText,
      'Recent Events',
      'Assigned to node-arm',
    ]) {
      expect(result.stdout).toContain(detail)
    }
    expect(result.stdout).not.toContain('unprinted-payload')
    const count = (await client.requests()).length
    const json = await client.run(['describe', 'run', 'verification', '-o', 'json'])
    const yaml = await client.run(['describe', 'run', 'verification', '-o', 'yaml'])
    expect(json.exitCode).toBe(0)
    expect(JSON.parse(json.stdout)).toEqual(verificationRun)
    expect(yaml.stdout).toContain('kind: AgentRun')
    expect(yaml.stdout).not.toContain('Recent Events')
    expect(await client.requests()).toHaveLength(count + 2)
  })
})
