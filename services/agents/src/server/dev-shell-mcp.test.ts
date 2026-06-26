import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DevShellRunner, handleDevShellMcpRequest } from './dev-shell-mcp'

const runners: DevShellRunner[] = []
const tempDirs: string[] = []

const makeRunner = () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'agents-dev-shell-'))
  tempDirs.push(workspaceRoot)
  const runner = new DevShellRunner({
    workspaceRoot,
    defaultTimeoutSeconds: 2,
    maxTimeoutSeconds: 5,
    defaultOutputBytes: 4096,
    maxOutputBytes: 8192,
    maxConcurrentJobs: 2,
    auditLogPath: null,
  })
  runners.push(runner)
  return runner
}

const post = async (runner: DevShellRunner, body: unknown) => {
  const response = await handleDevShellMcpRequest(
    new Request('http://127.0.0.1:8090/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    runner,
  )
  const json = response.status === 202 || response.status === 204 ? null : await response.json()
  return { response, json }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const readUntilStdoutIncludes = async (runner: DevShellRunner, jobId: string, expected: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = await post(runner, {
      jsonrpc: '2.0',
      id: `read-${attempt}`,
      method: 'tools/call',
      params: { name: 'shell_read', arguments: { jobId } },
    })
    if (String(read.json?.result?.structuredContent?.stdout ?? '').includes(expected)) return read
    await sleep(50)
  }
  return post(runner, {
    jsonrpc: '2.0',
    id: 'read-final',
    method: 'tools/call',
    params: { name: 'shell_read', arguments: { jobId } },
  })
}

afterEach(() => {
  for (const runner of runners.splice(0)) {
    runner.shutdown()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Agents dev-shell MCP handler', () => {
  it('supports initialize and advertises destructive shell tools', async () => {
    const runner = makeRunner()

    const init = await post(runner, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(init.response.status).toBe(200)
    expect(init.json?.result?.serverInfo?.name).toBe('agents-dev-shell')

    const list = await post(runner, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(list.response.status).toBe(200)
    const tools = list.json?.result?.tools as Array<{ name: string; annotations?: Record<string, unknown> }>
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['shell_run', 'shell_start', 'shell_read', 'shell_kill', 'shell_status']),
    )

    const runTool = tools.find((tool) => tool.name === 'shell_run')
    expect(runTool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    })
  })

  it('runs a short shell command and returns stdout, stderr, and exit code', async () => {
    const runner = makeRunner()

    const result = await post(runner, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'shell_run',
        arguments: {
          command: 'printf "hello"; printf "problem" >&2; exit 7',
        },
      },
    })

    expect(result.response.status).toBe(200)
    expect(result.json?.result?.structuredContent).toMatchObject({
      command: 'printf "hello"; printf "problem" >&2; exit 7',
      status: 'exited',
      exitCode: 7,
      stdout: 'hello',
      stderr: 'problem',
      timedOut: false,
    })
  })

  it('rejects working directories outside the workspace root', async () => {
    const runner = makeRunner()

    const result = await post(runner, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'shell_run',
        arguments: {
          command: 'pwd',
          cwd: '../../',
        },
      },
    })

    expect(result.response.status).toBe(200)
    expect(result.json?.error?.code).toBe(-32602)
    expect(result.json?.error?.message).toContain('cwd must stay under')
  })

  it('starts, reads, lists, and kills a long-running shell job', async () => {
    const runner = makeRunner()

    const start = await post(runner, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'shell_start',
        arguments: {
          command: 'while true; do echo tick; sleep 0.1; done',
          timeoutSeconds: 5,
        },
      },
    })
    const jobId = start.json?.result?.structuredContent?.jobId as string
    expect(jobId).toBeTruthy()

    const read = await readUntilStdoutIncludes(runner, jobId, 'tick')
    expect(read.json?.result?.structuredContent?.status).toBe('running')
    expect(read.json?.result?.structuredContent?.stdout).toContain('tick')

    const status = await post(runner, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'shell_status', arguments: { limit: 10 } },
    })
    expect(status.json?.result?.structuredContent?.jobs?.some((job: { jobId: string }) => job.jobId === jobId)).toBe(
      true,
    )

    const killed = await post(runner, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'shell_kill', arguments: { jobId } },
    })
    expect(killed.json?.result?.structuredContent?.status).toBe('killed')
  })

  it('times out shell_run commands', async () => {
    const runner = makeRunner()

    const result = await post(runner, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'shell_run',
        arguments: {
          command: 'sleep 2',
          timeoutSeconds: 1,
        },
      },
    })

    expect(result.response.status).toBe(200)
    expect(result.json?.result?.structuredContent).toMatchObject({
      status: 'timed_out',
      timedOut: true,
    })
  })
})
