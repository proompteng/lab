import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import * as grpc from '@grpc/grpc-js'
import { loadSync } from '@grpc/proto-loader'

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
printf '%s\\n' "$@" > "$AGENTCTL_FIXTURE_ARGS"
printf '%s\\n' '{"items":[],"metadata":{"name":"fixture"}}'
`,
  )
  await chmod(kubectl, 0o755)
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

const run = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, entry, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
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
    }
    for (const args of [['not-a-command'], ['run', 'submit'], ['get', 'agent', '--unknown']]) {
      const result = await run(args)
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('USAGE')
    }
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
