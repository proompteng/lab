import { encodeOutputCursor, jobMetadata } from './agents-shell/jobs'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { auditStdout, flushAuditLog, writeAuditLog } from './agents-shell/audit'
import {
  AgentsShellRunner,
  createAgentsShellServer,
  defaultAgentsShellConfigFromEnv,
  type AuthContext,
} from './agents-shell-mcp'

const roots: string[] = []
const connections: Array<{
  client: Client
  server: ReturnType<typeof createAgentsShellServer>
  runner: AgentsShellRunner
}> = []
const authFixture = (subject = 'owner-a'): AuthContext => ({
  subject,
  email: null,
  username: null,
  scopes: new Set(['agents-shell.read']),
  payload: {},
})
const configFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-shell-audit-'))
  roots.push(root)
  return defaultAgentsShellConfigFromEnv({
    AGENTS_SHELL_WORKSPACE_ROOT: root,
    AGENTS_SHELL_AUDIT_LOG_PATH: '',
    AGENTS_SHELL_DEFAULT_TIMEOUT_SECONDS: '5',
  })
}
const connect = async (runner = new AgentsShellRunner(configFixture()), auth = authFixture()) => {
  const sessionId = `repo-audit-${auth.subject}`
  const worktree = join(runner.config.workspaceRoot, 'worktrees', 'lab', auth.subject)
  mkdirSync(worktree, { recursive: true })
  runner.repoSessions.set({
    id: sessionId,
    ownerSubject: auth.subject,
    worktree,
    baseBranch: 'main',
    baseSha: 'a'.repeat(40),
    branch: `codex/audit-${auth.subject}`,
    createdAt: new Date().toISOString(),
  })
  const server = createAgentsShellServer(runner.config, runner, auth, 'request-fixture')
  const client = new Client({ name: 'audit-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  connections.push({ client, server, runner })
  return { client, runner, config: runner.config, sessionId }
}
const data = (result: Record<string, unknown>) => result.structuredContent as Record<string, unknown>
const captureAudit = () => {
  const log = vi.spyOn(auditStdout, 'write').mockImplementation(() => true)
  const frames = () =>
    log.mock.calls.flatMap(([line]) => {
      const value = JSON.parse(String(line))
      return value.msg === 'agents-shell audit' ? [value] : []
    })
  const records = () => {
    const events = new Map<string, any[]>()
    for (const frame of frames()) events.set(frame.eventId, [...(events.get(frame.eventId) ?? []), frame])
    return [...events.values()].map((parts) => {
      if (parts[0].payload) return parts[0]
      expect(parts).toHaveLength(parts[0].fragmentCount)
      const unique = new Map(parts.map((part) => [part.fragmentIndex, part]))
      const json = [...unique.values()]
        .sort((a, b) => a.fragmentIndex - b.fragmentIndex)
        .map((part) => part.payloadFragment)
        .join('')
      expect(Buffer.byteLength(json)).toBe(parts[0].payloadBytes)
      return { ...parts[0], payload: JSON.parse(json) }
    })
  }
  return { frames, records }
}
afterEach(async () => {
  for (const { client, server, runner } of connections.splice(0)) {
    runner.shutdown()
    await client.close()
    await server.close()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('complete operational activity export', () => {
  it('retains ordinary command, arguments, paths, code, errors and output in both sinks', () => {
    const { records } = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    vi.stubEnv('SYNTHETIC_API_TOKEN', 'synthetic-runtime-credential')
    const payload = {
      command: 'git show abc123 -- src/token-count.ts',
      arguments: { args: ['show', 'abc123', '--password', 'synthetic-cli-password'], cwd: '/workspace/repo-a' },
      result: {
        content: 'const tokenCount = 400;\n',
        stdout: '雪😀 complete output synthetic-runtime-credential',
        stderr: 'precise ordinary failure',
        password: 'synthetic-password',
        authorization: 'Bearer synthetic-header',
        document: { kind: 'Secret', data: { registry: 'c3ludGhldGljLWNyZWRlbnRpYWw=' } },
        status: 'exited',
        exitCode: 1,
      },
    }
    writeAuditLog(config, 'probe', authFixture(), payload)
    expect(records()[0]).toMatchObject({ schemaVersion: 2, payload, payloadTruncated: false, maskedValues: 0 })
    expect(JSON.parse(readFileSync(config.auditLogPath, 'utf8'))).toEqual(records()[0])
    expect(records()[0].subjectHash).toBe(createHash('sha256').update('owner-a').digest('hex'))
  })

  it('frames large Unicode/control-character payloads without dropping content', () => {
    const { frames, records } = captureAudit()
    const payload = { command: 'ordinary command', content: '\u0000雪😀'.repeat(20_000) }
    writeAuditLog(configFixture(), 'probe', authFixture(), payload)
    expect(records()[0].payload).toEqual(payload)
    expect(frames().length).toBeGreaterThan(1)
    for (const frame of frames()) expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(16_000)
  })

  it('honors drain for a large generic tool result after process completion', async () => {
    const writes: string[] = []
    let first = true
    vi.spyOn(auditStdout, 'write').mockImplementation((line) => {
      writes.push(line)
      if (first) {
        first = false
        return false
      }
      return true
    })
    const payload = { outcome: 'succeeded', result: { content: 'ordinary output '.repeat(30_000) } }
    writeAuditLog(configFixture(), 'tool_call_finished', authFixture(), payload)
    expect(writes).toHaveLength(1)
    const flushed = flushAuditLog()
    process.stdout.emit('drain')
    expect(await flushed).toMatchObject({ pendingBytes: 0, pendingFrames: 0, rejectedFrames: 0, failedWrites: 0 })
    const frames = writes.map((line) => JSON.parse(line))
    expect(frames).toHaveLength(frames[0].fragmentCount)
    expect(JSON.parse(frames.map((frame) => frame.payloadFragment).join(''))).toEqual(payload)
  })

  it('does not dispatch array map overrides during raw export', () => {
    const { records } = captureAudit()
    const items = ['ordinary']
    Object.defineProperty(items, 'map', {
      value() {
        throw new Error('map override invoked')
      },
    })
    writeAuditLog(configFixture(), 'probe', authFixture(), { items })
    expect(records()[0].payload).toEqual({ items: ['ordinary'] })
  })

  it('rejects oversized events before copying or serialization with a bounded explicit receipt', () => {
    const { frames, records } = captureAudit()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const patch = 'ordinary'.repeat(1_100_000)
    let touched = false
    const payload = {
      patch,
      get later() {
        touched = true
        throw new Error('must not invoke')
      },
    }
    expect(writeAuditLog(configFixture(), 'tool_call_started', authFixture(), payload)).toBe(1)
    expect(touched).toBe(false)
    expect(payload.patch).toBe(patch)
    expect(frames()).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(frames()[0]))).toBeLessThan(2000)
    expect(records()[0]).toMatchObject({
      event: 'tool_call_started',
      payloadTruncated: true,
      captureIncomplete: true,
      payload: {
        captureIncomplete: true,
        originalResultUnchanged: true,
        rejection: { accepted: false, reason: 'event_byte_budget_exceeded', byteBudget: 8 * 1024 * 1024 },
      },
    })
  })

  it('preserves complete ordinary 3.2 MiB generic results under the event budget', () => {
    const { records } = captureAudit()
    const payload = { result: { content: 'ordinary'.repeat(400_000) } }
    expect(writeAuditLog(configFixture(), 'tool_call_finished', authFixture(), payload)).toBe(0)
    expect(records()[0]).toMatchObject({ captureIncomplete: false, payload })
  })

  it('exports complete concurrent stdout/stderr past response caps and keeps owned agents discoverable', async () => {
    const { records } = captureAudit()
    const { client, runner, sessionId } = await connect()
    const expected = new Map<string, { stdout: string; stderr: string }>()
    const jobs = await Promise.all(
      ['agent-a', 'agent-b'].map(async (agentId) => {
        const stdout = `${agentId}:雪😀\n`.repeat(30_000)
        const stderr = `${agentId}:diagnostic\n`.repeat(20_000)
        const command = `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(`${agentId}:雪😀\n`)}.repeat(30000)); process.stderr.write(${JSON.stringify(`${agentId}:diagnostic\n`)}.repeat(20000))`)}`
        const result = await client.callTool({
          name: 'exec',
          arguments: { sessionId, command, agentId, requestKey: crypto.randomUUID(), waitMs: 0, maxBytes: 8192 },
        })
        const jobId = String(data(result).jobId)
        expected.set(jobId, { stdout, stderr })
        return jobId
      }),
    )
    await vi.waitFor(
      () => {
        for (const id of jobs) expect(runner.requireJob(id, authFixture()).finishedAt).not.toBeNull()
      },
      { timeout: 8000 },
    )
    const listed = await client.callTool({ name: 'status', arguments: {} })
    expect((data(listed).jobs as any[]).map((job) => job.agentId).sort()).toEqual(['agent-a', 'agent-b'])
    for (const frame of records().filter(
      (event) => event.event === 'shell_job_started' || event.event === 'process_output',
    )) {
      expect(frame.taskId).toBe(frame.payload.taskId)
      expect(frame.taskId).toBe(sessionId)
      if (frame.event === 'shell_job_started') expect(frame.requestKey).toBe(frame.payload.requestKey)
    }
    for (const jobId of jobs) {
      for (const stream of ['stdout', 'stderr'] as const) {
        const chunks = records()
          .filter(
            (event) =>
              event.event === 'process_output' && event.payload.jobId === jobId && event.payload.stream === stream,
          )
          .sort((a, b) => a.payload.sequence - b.payload.sequence)
        let offset = 0
        for (let i = 0; i < chunks.length; i += 1) {
          expect(chunks[i].payload.sequence).toBe(i)
          expect(chunks[i].payload.byteStart).toBe(offset)
          offset = chunks[i].payload.byteEnd
        }
        const original = expected.get(jobId)![stream]
        expect(chunks.map((event) => event.payload.text).join('')).toBe(original)
        expect(offset).toBe(Buffer.byteLength(original))
        expect(
          records().find(
            (event) =>
              event.event === 'process_output_finished' &&
              event.payload.jobId === jobId &&
              event.payload.stream === stream,
          )?.payload,
        ).toMatchObject({
          totalBytes: Buffer.byteLength(original),
          capturedBytes: Buffer.byteLength(original),
          sinkErrors: 0,
          captureError: null,
          sha256: createHash('sha256').update(original).digest('hex'),
        })
      }
      let offset = 0
      let cursor = encodeOutputCursor({
        jobId,
        stdoutOffset: 0,
        stderrOffset: Buffer.byteLength(expected.get(jobId)!.stderr),
        outputEncoding: 'utf8',
      })
      let text = ''
      do {
        const read = await client.callTool({
          name: 'read',
          arguments: {
            jobId,
            cursor,
            maxBytes: 20_000,
          },
        })
        text += data(read).stdout
        offset = Number(data(read).stdoutNextOffset)
        cursor = String(data(read).cursor)
      } while (offset < Buffer.byteLength(expected.get(jobId)!.stdout))
      expect(text).toBe(expected.get(jobId)!.stdout)
    }
  })

  it('prevents another owner from reading, listing or stopping jobs', async () => {
    const { records } = captureAudit()
    const { client, runner, sessionId } = await connect()
    const second = await connect(runner, authFixture('owner-b'))
    const start = await client.callTool({
      name: 'exec',
      arguments: { sessionId, requestKey: crypto.randomUUID(), command: 'sleep 3', agentId: 'owner-b', waitMs: 0 },
    })
    const jobId = data(start).jobId
    const cursor = data(start).cursor
    expect(data(await second.client.callTool({ name: 'status', arguments: {} })).jobs).toEqual([])
    for (const name of ['read', 'cancel', 'status'])
      expect((await second.client.callTool({ name, arguments: { jobId, cursor } })).isError).toBe(true)
    expect(jobMetadata(runner.requireJob(String(jobId), authFixture())).state).toBe('running')
    await client.callTool({ name: 'cancel', arguments: { jobId } })
    await vi.waitFor(() => expect(runner.requireJob(String(jobId), authFixture()).finishedAt).not.toBeNull())
    expect(jobMetadata(runner.requireJob(String(jobId), authFixture())).state).toBe('cancelled')
    expect(
      records()
        .filter((event) => event.event === 'tool_call_finished' && event.tool === 'cancel')
        .at(-1)?.payload.outcome,
    ).toBe('succeeded')
    const read = await client.callTool({ name: 'read', arguments: { jobId, cursor } })
    expect(data(read)).toMatchObject({ state: 'cancelled', ok: false })
    expect(
      records()
        .filter((event) => event.event === 'tool_call_finished' && event.tool === 'read')
        .at(-1)?.payload.outcome,
    ).toBe('succeeded')
  })

  it('mirrors CLI tools and retains raw argv with exact failure details', async () => {
    const { records } = captureAudit()
    const { client, config } = await connect()
    const executable = join(config.workspaceRoot, 'kubectl')
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf "ordinary command output\\n"; printf "exact command failure\\n" >&2; exit 7\n',
      { mode: 0o755 },
    )
    vi.stubEnv('PATH', `${config.workspaceRoot}:${process.env.PATH}`)
    const response = await client.callTool({
      name: 'kubectl_admin',
      arguments: { args: ['exec', 'pod/fixture', '--', 'client', '--password', 'synthetic-cli-password'] },
    })
    expect(response.structuredContent).toMatchObject({
      exitCode: 7,
      stdout: 'ordinary command output\n',
      stderr: 'exact command failure\n',
    })
    expect(JSON.stringify(response.structuredContent)).toContain('synthetic-cli-password')
    expect(JSON.stringify(records())).toContain('synthetic-cli-password')
    expect(
      records()
        .filter((event) => event.event === 'process_output')
        .map((event) => event.payload.text)
        .join(''),
    ).toContain('exact command failure')
  })

  it('can inspect its growing local log without recursively amplifying it', async () => {
    const { records } = captureAudit()
    const { client, config, sessionId } = await connect()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    const response = await client.callTool({
      name: 'exec',
      arguments: {
        sessionId,
        requestKey: crypto.randomUUID(),
        command: `timeout 1 tail -n +1 -f ${config.auditLogPath}`,
        maxBytes: 20_000,
        waitMs: 3000,
      },
    })
    expect(data(response).stdout).toContain('agents-shell audit')
    expect(records().filter((event) => event.event === 'process_output')).toHaveLength(0)
    expect(
      records().find((event) => event.event === 'process_output_finished' && event.payload.stream === 'stdout')?.payload
        .selfAuditFramesSuppressed,
    ).toBeGreaterThan(0)
    expect(records().length).toBeLessThan(12)
  })

  it('does not export delegated model log bodies through lower-level process mirroring', async () => {
    const { records } = captureAudit()
    const { client, config } = await connect()
    writeFileSync(join(config.workspaceRoot, 'kubectl'), '#!/bin/sh\nprintf "synthetic-protected-model-log"\n', {
      mode: 0o755,
    })
    vi.stubEnv('PATH', `${config.workspaceRoot}:${process.env.PATH}`)
    await client.callTool({ name: 'agent_read', arguments: { agentRunName: 'fixture' } })
    expect(JSON.stringify(records())).not.toContain('synthetic-protected-model-log')
  })

  it('records useful tool errors while withholding unauthenticated arguments', async () => {
    const { records } = captureAudit()
    const { client } = await connect()
    const response = await client.callTool({ name: 'status', arguments: { jobId: 'missing-job' } })
    expect(response.isError).toBe(true)
    expect(JSON.stringify(records())).toContain('unknown or expired jobId: missing-job')
    const auth = authFixture('unauthenticated')
    auth.scopes.clear()
    const denied = await connect(undefined, auth)
    await denied.client.callTool({
      name: 'exec',
      arguments: { requestKey: crypto.randomUUID(), command: 'sensitive-denied-input' },
    })
    expect(JSON.stringify(records())).not.toContain('sensitive-denied-input')
  })
})
