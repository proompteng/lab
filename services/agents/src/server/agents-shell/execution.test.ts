import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as Schema from 'effect/Schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { auditStdout } from './audit'
import { defaultAgentsShellConfigFromEnv } from './config'
import { AgentsShellRunner } from './runner'
import { ExecutionOutputSchema } from './schemas'
import { createAgentsShellServer } from './server'
import { createAgentsShellRequestHandler } from './http'
import type { AuthContext } from './auth'

const auth: AuthContext = {
  subject: 'owner',
  email: null,
  username: null,
  payload: {},
  scopes: new Set(['agents-shell.read']),
}
const connections: Array<{
  runner: AgentsShellRunner
  client: Client
  server: ReturnType<typeof createAgentsShellServer>
}> = []
const roots: string[] = []
const connect = async (maxConcurrentJobs = 4) => {
  const root = mkdtempSync(join(tmpdir(), 'shell-execution-'))
  roots.push(root)
  const config = defaultAgentsShellConfigFromEnv({ AGENTS_SHELL_WORKSPACE_ROOT: root, AGENTS_SHELL_AUDIT_LOG_PATH: '' })
  config.maxConcurrentJobs = maxConcurrentJobs
  const runner = new AgentsShellRunner(config)
  const sessionId = 'repo-execution-test'
  const worktree = join(root, 'worktrees', 'lab', 'execution-test')
  mkdirSync(worktree, { recursive: true })
  runner.repoSessions.set({
    id: sessionId,
    ownerSubject: auth.subject,
    worktree,
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    branch: 'codex/execution-test',
    createdAt: new Date().toISOString(),
  })
  const server = createAgentsShellServer(config, runner, auth, 'execution-test')
  const client = new Client({ name: 'execution-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  connections.push({ runner, client, server })
  return { runner, client, root: worktree, workspaceRoot: root, sessionId }
}
const output = (result: Awaited<ReturnType<Client['callTool']>>) => {
  expect(result.isError).not.toBe(true)
  return Schema.decodeUnknownSync(ExecutionOutputSchema)(result.structuredContent)
}
beforeEach(() => {
  vi.spyOn(auditStdout, 'write').mockImplementation(() => true)
})
afterEach(async () => {
  for (const { runner, client, server } of connections.splice(0)) {
    runner.shutdown()
    await vi.waitFor(() => expect(runner.runningJobs()).toHaveLength(0), { timeout: 3000 })
    await client.close()
    await server.close()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('one execution contract', () => {
  it.each(['lab/seed', 'worktrees/lab/victim/result'])(
    'rejects sessionless commands that reach %s from the workspace root',
    async (target) => {
      const { client, workspaceRoot: root, runner } = await connect()
      mkdirSync(join(root, target, '..'), { recursive: true })
      const rejected = await client.callTool({
        name: 'exec',
        arguments: { requestKey: 'unscoped-seed', command: `printf changed > ${target}`, waitMs: 3000 },
      })
      expect(rejected.isError).toBe(true)
      expect(existsSync(join(root, target))).toBe(false)
      expect(runner.jobs.size).toBe(0)
    },
  )
  it('rejects another owner before spawning in a repo session', async () => {
    const { runner, sessionId, root } = await connect()
    const foreignAuth = { ...auth, subject: 'foreign-owner' }
    const server = createAgentsShellServer(runner.config, runner, foreignAuth)
    const client = new Client({ name: 'foreign-owner', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    connections.push({ runner, client, server })
    const rejected = await client.callTool({
      name: 'exec',
      arguments: { sessionId, requestKey: 'foreign', command: 'printf changed > result', waitMs: 3000 },
    })
    expect(rejected.isError).toBe(true)
    expect(JSON.stringify(rejected.content)).toContain('owned by another subject')
    expect(existsSync(join(root, 'result'))).toBe(false)
    expect(runner.jobs.size).toBe(0)
  })
  it.each([
    ['AGENTS_SHELL_MAX_CONCURRENT_JOBS', '0'],
    ['AGENTS_SHELL_MAX_CONCURRENT_JOBS', '9'],
    ['AGENTS_SHELL_MAX_CONCURRENT_JOBS', '1.5'],
    ['AGENTS_SHELL_DEFAULT_OUTPUT_BYTES', '1024'],
    ['AGENTS_SHELL_MAX_OUTPUT_BYTES', 'NaN'],
    ['AGENTS_SHELL_MAX_TIMEOUT_SECONDS', '0'],
  ])('rejects invalid resource configuration %s=%s', (key, value) => {
    expect(() => defaultAgentsShellConfigFromEnv({ [key]: value })).toThrow(key)
  })
  it('publishes one versioned catalog on both in-process and HTTP transports', async () => {
    const { client, runner } = await connect()
    const catalog = await client.listTools()
    expect(catalog._meta?.['agents-shell/catalog']).toMatchObject({
      version: '0.2.2',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const handler = createAgentsShellRequestHandler(runner.config, runner)
    const response = await handler(
      new Request('https://agents-shell.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    expect(await response.json()).toMatchObject({ result: catalog })
    const result = await client.callTool({ name: 'status', arguments: {} })
    expect(result._meta?.['agents-shell/catalog']).toEqual(catalog._meta?.['agents-shell/catalog'])
  })
  it('returns a terminal receipt for a quick command and consumes output exactly once', async () => {
    const { client, sessionId } = await connect()
    const executed = output(
      await client.callTool({
        name: 'exec',
        arguments: { sessionId, requestKey: 'quick', command: 'printf hello', waitMs: 3000 },
      }),
    )
    expect(executed).toMatchObject({
      state: 'exited',
      ok: true,
      exitCode: 0,
      stdout: 'hello',
      captureIncomplete: false,
    })
    expect(executed.commandHash).toMatch(/^[a-f0-9]{64}$/)
    expect(executed.taskId).toBe(sessionId)
    const read = output(
      await client.callTool({ name: 'read', arguments: { jobId: executed.jobId, cursor: executed.cursor } }),
    )
    expect(read).toMatchObject({ state: 'exited', stdout: '', stderr: '', stdoutNextOffset: 5 })
    expect(read.cursor).toBe(executed.cursor)
  })

  it('waits for readable output, then completion without busy polling', async () => {
    const { client, sessionId } = await connect()
    const executed = output(
      await client.callTool({
        name: 'exec',
        arguments: { sessionId, requestKey: 'wait', command: 'sleep 0.15; printf ready; sleep 0.15', waitMs: 0 },
      }),
    )
    expect(executed).toMatchObject({ state: 'running', ok: null })
    const first = output(
      await client.callTool({
        name: 'read',
        arguments: { jobId: executed.jobId, cursor: executed.cursor, waitMs: 3000 },
      }),
    )
    expect(first.stdout).toBe('ready')
    const final = output(
      await client.callTool({ name: 'read', arguments: { jobId: executed.jobId, cursor: first.cursor, waitMs: 3000 } }),
    )
    expect(final).toMatchObject({ state: 'exited', ok: true, stdout: '' })
  })

  it('launches concurrent retries once and rejects reuse for different execution input', async () => {
    const { client, root, sessionId } = await connect()
    const args = { sessionId, requestKey: 'retry', command: 'printf once >> count; sleep 0.15', waitMs: 3000 }
    const [first, retry] = await Promise.all([
      client.callTool({ name: 'exec', arguments: args }),
      client.callTool({ name: 'exec', arguments: args }),
    ])
    expect(output(first).jobId).toBe(output(retry).jobId)
    expect(readFileSync(join(root, 'count'), 'utf8')).toBe('once')
    const later = output(await client.callTool({ name: 'exec', arguments: { ...args, maxBytes: 8192, waitMs: 0 } }))
    expect(later.jobId).toBe(output(first).jobId)
    const conflict = await client.callTool({ name: 'exec', arguments: { ...args, command: 'printf twice >> count' } })
    expect(conflict.isError).toBe(true)
    expect(conflict.structuredContent).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(readFileSync(join(root, 'count'), 'utf8')).toBe('once')
  })

  it('waits for capacity and returns actionable pressure without launching twice', async () => {
    const { client, root, sessionId } = await connect(1)
    const first = output(
      await client.callTool({
        name: 'exec',
        arguments: { sessionId, requestKey: 'occupy', command: 'sleep 0.3', waitMs: 0 },
      }),
    )
    expect(first.state).toBe('running')
    const busyArgs = { sessionId, requestKey: 'next', command: 'printf admitted > count', waitMs: 0 }
    const busy = await client.callTool({ name: 'exec', arguments: busyArgs })
    expect(busy.isError).toBe(true)
    expect(busy.structuredContent).toMatchObject({ code: 'CAPACITY_BUSY', retryAfterMs: 250 })
    const admitted = output(await client.callTool({ name: 'exec', arguments: { ...busyArgs, waitMs: 3000 } }))
    expect(admitted).toMatchObject({ state: 'exited', ok: true })
    expect(readFileSync(join(root, 'count'), 'utf8')).toBe('admitted')
  })

  it('bounds a duplicate caller wait while another caller waits for admission', async () => {
    const { client, sessionId } = await connect(1)
    await client.callTool({
      name: 'exec',
      arguments: { sessionId, requestKey: 'occupy', command: 'sleep 0.4', waitMs: 0 },
    })
    const args = { sessionId, requestKey: 'pending', command: 'printf once', waitMs: 3000 }
    const pending = client.callTool({ name: 'exec', arguments: args })
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    const start = performance.now()
    const busy = await client.callTool({ name: 'exec', arguments: { ...args, waitMs: 0 } })
    expect(busy.structuredContent).toMatchObject({ code: 'CAPACITY_BUSY' })
    expect(performance.now() - start).toBeLessThan(250)
    expect(output(await pending)).toMatchObject({ stdout: 'once', state: 'exited' })
  })

  it('cancels a stubborn process group, escalates, and returns the same terminal receipt', async () => {
    const { client, sessionId } = await connect()
    const executed = output(
      await client.callTool({
        name: 'exec',
        arguments: {
          sessionId,
          requestKey: 'cancel',
          command: "trap '' TERM; printf ready; while :; do sleep 1; done",
          waitMs: 0,
        },
      }),
    )
    const ready = output(
      await client.callTool({
        name: 'read',
        arguments: { jobId: executed.jobId, cursor: executed.cursor, waitMs: 3000 },
      }),
    )
    expect(ready.stdout).toBe('ready')
    const cancelled = await client.callTool({ name: 'cancel', arguments: { jobId: executed.jobId } })
    expect(cancelled.isError).not.toBe(true)
    expect(cancelled.structuredContent).toMatchObject({
      state: 'cancelled',
      ok: false,
      signal: 'SIGKILL',
      finishedAt: expect.any(String),
    })
    const again = await client.callTool({ name: 'cancel', arguments: { jobId: executed.jobId } })
    expect(again.structuredContent).toEqual(cancelled.structuredContent)
  })

  it('reports timeout and nonzero exit as terminal failures', async () => {
    const { client, sessionId } = await connect()
    const failed = output(
      await client.callTool({
        name: 'exec',
        arguments: { sessionId, requestKey: 'fail', command: 'printf diagnostic >&2; exit 7', waitMs: 3000 },
      }),
    )
    expect(failed).toMatchObject({ state: 'exited', ok: false, exitCode: 7, stderr: 'diagnostic' })
    const timeout = output(
      await client.callTool({
        name: 'exec',
        arguments: {
          sessionId,
          requestKey: 'timeout',
          command: "trap '' TERM; sleep 30",
          timeoutSeconds: 1,
          waitMs: 3000,
        },
      }),
    )
    expect(timeout).toMatchObject({ state: 'timed_out', ok: false, signal: 'SIGKILL' })
  })

  it('bounds the serialized MCP reply for large commands and escaped output', async () => {
    const { client, sessionId } = await connect()
    const command = "printf '%s' '" + '\u0001"雪😀'.repeat(2000) + "'"
    const result = await client.callTool({
      name: 'exec',
      arguments: { sessionId, requestKey: 'bytes', command, waitMs: 3000, maxBytes: 8192 },
    })
    const page = output(result)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(page.commandPreview)).toBeLessThanOrEqual(160)
    expect(page).not.toHaveProperty('command')
    expect(page.stdoutHasMore).toBe(true)
    const status = await client.callTool({ name: 'status', arguments: {} })
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThanOrEqual(8192)
    expect(status.structuredContent).not.toHaveProperty('stdout')
  })

  it('fits an ordinary complete receipt into the minimum reply budget', async () => {
    const { client, sessionId } = await connect()
    const result = await client.callTool({
      name: 'exec',
      arguments: { sessionId, requestKey: 'minimum', command: 'printf small', waitMs: 3000, maxBytes: 4096 },
    })
    expect(output(result)).toMatchObject({ state: 'exited', ok: true, stdout: 'small' })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
  })

  it('retrieves exact arbitrary bytes from the first page and permits encoding changes on retries', async () => {
    const { client, sessionId } = await connect()
    const args = { sessionId, requestKey: 'binary', command: "printf '\\000\\377\\200'", waitMs: 3000 }
    const first = output(await client.callTool({ name: 'exec', arguments: args }))
    const binary = output(await client.callTool({ name: 'exec', arguments: { ...args, outputEncoding: 'base64' } }))
    expect(binary.jobId).toBe(first.jobId)
    expect(Buffer.from(binary.stdout, 'base64')).toEqual(Buffer.from([0, 255, 128]))
    const next = output(
      await client.callTool({ name: 'read', arguments: { jobId: binary.jobId, cursor: binary.cursor } }),
    )
    expect(next).toMatchObject({ stdout: '', outputEncoding: 'base64', stdoutNextOffset: 3 })
  })

  it('rejects an insufficient metadata budget before launching and allows a larger-budget retry', async () => {
    const { client, root, runner, sessionId } = await connect()
    const args = {
      sessionId,
      requestKey: 'metadata',
      agentId: 'a'.repeat(128),
      command: '#' + '\u0001'.repeat(200) + '\nprintf happened > touched',
      waitMs: 3000,
    }
    const small = await client.callTool({ name: 'exec', arguments: { ...args, maxBytes: 4096 } })
    expect(small.isError).toBe(true)
    expect(JSON.stringify(small.content)).toContain('reply budget')
    expect(runner.jobs.size).toBe(0)
    expect(existsSync(join(root, 'touched'))).toBe(false)
    expect(output(await client.callTool({ name: 'exec', arguments: { ...args, maxBytes: 8192 } }))).toMatchObject({
      state: 'exited',
      ok: true,
    })
    expect(readFileSync(join(root, 'touched'), 'utf8')).toBe('happened')
  })

  it('rejects legacy tools, missing request keys, invalid cursors, and writes without repo sessions', async () => {
    const { client, root, runner, sessionId } = await connect()
    for (const name of ['shell_run', 'shell_start', 'shell_read', 'shell_kill', 'shell_status']) {
      expect((await client.callTool({ name, arguments: { command: 'printf should-not-run' } })).isError).toBe(true)
    }
    expect(
      (await client.callTool({ name: 'exec', arguments: { sessionId, command: 'printf should-not-run' } })).isError,
    ).toBe(true)
    mkdirSync(join(root, 'lab'))
    const seed = await client.callTool({
      name: 'exec',
      arguments: { requestKey: 'seed', cwd: 'lab', command: 'printf should-not-run' },
    })
    expect(seed.isError).toBe(true)
    expect(JSON.stringify(seed.content)).toContain('Input validation error')
    for (const name of ['apply_patch', 'git_write']) {
      expect(
        (await client.callTool({ name, arguments: { patch: '*** Begin Patch\n*** End Patch', args: ['commit'] } }))
          .isError,
      ).toBe(true)
    }
    expect(runner.jobs.size).toBe(0)
  })
})
