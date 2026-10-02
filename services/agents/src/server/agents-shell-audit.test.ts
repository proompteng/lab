import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeAuditLog } from './agents-shell/audit'
import {
  AgentsShellRunner,
  createAgentsShellRequestHandler,
  createAgentsShellServer,
  defaultAgentsShellConfigFromEnv,
  type AuthContext,
} from './agents-shell-mcp'

const AuditSchema = Schema.Struct({
  msg: Schema.Literal('agents-shell audit'),
  schemaVersion: Schema.Literal(1),
  ts: Schema.String,
  event: Schema.String,
  requestId: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  subjectHash: Schema.NullOr(Schema.String),
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  payloadTruncated: Schema.Boolean,
})
const parseAudit = Schema.decodeUnknownSync(AuditSchema)
const parseJob = Schema.decodeUnknownSync(Schema.Struct({ jobId: Schema.String }))
const roots: string[] = []
const connections: Array<{
  client: Client
  server: ReturnType<typeof createAgentsShellServer>
  runner: AgentsShellRunner
}> = []

const configFixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-shell-audit-'))
  roots.push(root)
  return defaultAgentsShellConfigFromEnv({
    AGENTS_SHELL_WORKSPACE_ROOT: root,
    AGENTS_SHELL_AUDIT_LOG_PATH: '',
    AGENTS_SHELL_DEFAULT_TIMEOUT_SECONDS: '5',
    AGENTS_SHELL_MAX_TIMEOUT_SECONDS: '10',
  })
}

const authFixture = (scopes = ['agents-shell.read', 'agents-shell.write']): AuthContext => ({
  subject: 'test-actor',
  email: 'actor@example.test',
  username: 'test-username',
  scopes: new Set(scopes),
  payload: {},
})

const captureAudit = () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  return () =>
    log.mock.calls.flatMap(([line]) => {
      const value: unknown = JSON.parse(String(line))
      return typeof value === 'object' && value !== null && 'msg' in value && value.msg === 'agents-shell audit'
        ? [parseAudit(value)]
        : []
    })
}

const connect = async (auth = authFixture()) => {
  const config = configFixture()
  const runner = new AgentsShellRunner(config)
  const server = createAgentsShellServer(config, runner, auth, 'request-fixture')
  const client = new Client({ name: 'audit-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  connections.push({ client, server, runner })
  return { config, client, runner }
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

describe('agents-shell activity audit', () => {
  it('exports only safe typed metadata and omits free-form input, echoed operands and unknown fields in both sinks', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    const privateText = 'customer-private-text-123-45-6789'
    writeAuditLog(config, 'probe', authFixture(), {
      command: privateText,
      args: [privateText],
      arguments: { path: privateText },
      password: privateText,
      [privateText]: privateText,
      result: {
        path: privateText,
        changedFiles: [privateText],
        branch: privateText,
        worktree: privateText,
        content: privateText,
        stdout: privateText,
        stderr: privateText,
        arbitrary: privateText,
        nested: { status: privateText },
        status: privateText,
        jobId: privateText,
        ok: true,
        exitCode: 0,
        stdoutBytes: 27,
        stderrBytes: 0,
      },
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain(privateText)
      expect(content).not.toContain('test-actor')
      expect(content).not.toContain('actor@example.test')
    }
    expect(records()[0]).toMatchObject({
      payload: {
        command: '[OMITTED]',
        arguments: '[OMITTED]',
        result: { path: '[OMITTED]', changedFiles: '[OMITTED]', ok: true, exitCode: 0, stdoutBytes: 27 },
      },
      payloadTruncated: false,
    })
    expect(records()[0].subjectHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(readFileSync(config.auditLogPath, 'utf8'))).toEqual(records()[0])
  })

  it('preserves generated identifiers, outcomes, timestamps and bounded process metadata', () => {
    const records = captureAudit()
    const payload = {
      jobId: '7f29c6aa-e612-4287-a8df-46d2e6a36719',
      sessionId: 'f8117bea-8bd5-4ed6-9ab7-fc04bcd30c87',
      status: 'killed',
      outcome: 'succeeded',
      signal: 'SIGTERM',
      exitCode: null,
      timedOut: false,
      startedAt: '2026-10-02T17:00:00.000Z',
      finishedAt: null,
      baseSha: 'a'.repeat(40),
    }
    writeAuditLog(configFixture(), 'probe', null, payload)
    expect(records()[0].payload).toEqual(payload)
  })

  it('bounds large job collections and processes opaque text without inspecting it', () => {
    const records = captureAudit()
    const start = performance.now()
    writeAuditLog(configFixture(), 'probe', null, {
      command: 'curl '.repeat(10_000),
      jobs: Array.from({ length: 100 }, () => ({ command: '\u0000雪'.repeat(10_000), stdoutBytes: 1 })),
    })
    expect(performance.now() - start).toBeLessThan(1_000)
    expect(records()[0].payloadTruncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(records()[0]))).toBeLessThan(14_000)
    expect(records()[0].payload.jobs).toHaveLength(20)
  })

  it('keeps delegated task text out of agent_status process and tool audit while retaining the response', async () => {
    const records = captureAudit()
    const { client, config } = await connect()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    const agentRunName = 'private-agent-task-derived-name'
    const agentRun = {
      kind: 'AgentRun',
      spec: {
        implementation: { inline: { summary: 'private-agent-summary', text: 'private-agent-task' } },
        goal: { objective: 'private-agent-objective' },
      },
    }
    const executable = join(config.workspaceRoot, 'kubectl')
    writeFileSync(
      executable,
      `#!/bin/bash\nif [ "$2" = agentrun ]; then printf '%s' '${JSON.stringify(agentRun)}'; else printf '%s' '{"kind":"JobList","items":[{"task":"private-agent-job-task"}]}'; fi\n`,
      { mode: 0o755 },
    )
    vi.stubEnv('PATH', `${config.workspaceRoot}:${process.env.PATH}`)
    const response = await client.callTool({ name: 'agent_status', arguments: { agentRunName } })
    expect(response.structuredContent).toMatchObject({ agentRunName, agentRun })
    for (const value of [
      'private-agent-summary',
      'private-agent-task',
      'private-agent-objective',
      'private-agent-job-task',
    ]) {
      expect(JSON.stringify(records())).not.toContain(value)
      expect(readFileSync(config.auditLogPath, 'utf8')).not.toContain(value)
    }
    expect(records().find(({ event }) => event === 'tool_call_started')).toMatchObject({
      payload: { arguments: '[OMITTED]' },
    })
    expect(records().find(({ event }) => event === 'agent_status_get_agentrun_finished')).toMatchObject({
      payload: { exitCode: 0 },
    })
    expect(records().find(({ event }) => event === 'tool_call_finished')?.payload).not.toHaveProperty('result')
  })

  it.each(['shell_run', 'shell_start'])('omits projected Secret output through %s and later reads', async (name) => {
    const records = captureAudit()
    const { client, config, runner } = await connect()
    const encoded = Buffer.from('synthetic-unrecognized-credential').toString('base64')
    const executable = join(config.workspaceRoot, 'kubectl')
    writeFileSync(executable, `#!/bin/bash\nprintf '${encoded}'; printf '${encoded}' >&2\n`, { mode: 0o755 })
    const response = await client.callTool({
      name,
      arguments: { command: `${executable} get secrets/fixture -o jsonpath='{.data.arbitrary}'` },
    })
    const { jobId } = parseJob(response.structuredContent)
    await vi.waitFor(() => expect(runner.requireJob(jobId).finishedAt).not.toBeNull(), { timeout: 4_000 })
    const read = await client.callTool({ name: 'shell_read', arguments: { jobId } })
    expect(read.structuredContent).toMatchObject({ stdout: encoded, stderr: encoded })
    await client.callTool({ name: 'shell_status', arguments: { jobId } })
    expect(JSON.stringify(records())).not.toContain(encoded)
    expect(records().find(({ event }) => event === 'shell_job_finished')).toMatchObject({
      payload: { stdoutBytes: encoded.length, stderrBytes: encoded.length, exitCode: 0 },
    })
  })

  it.each(['shell_run', 'shell_start'])(
    'omits dynamically selected resource output through %s and later reads',
    async (name) => {
      const records = captureAudit()
      const { client, config, runner } = await connect()
      config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
      const encoded = Buffer.from('synthetic-dynamic-credential').toString('base64')
      const executable = join(config.workspaceRoot, 'kubectl')
      writeFileSync(executable, `#!/bin/bash\nprintf '%s' '${encoded}'; printf '%s' '${encoded}' >&2\n`, {
        mode: 0o755,
      })
      const response = await client.callTool({
        name,
        arguments: { command: `${executable} get se""cret/fixture -o jsonpath='{.data.arbitrary}'` },
      })
      const { jobId } = parseJob(response.structuredContent)
      await vi.waitFor(() => expect(runner.requireJob(jobId).finishedAt).not.toBeNull(), { timeout: 4_000 })
      const read = await client.callTool({ name: 'shell_read', arguments: { jobId } })
      expect(read.structuredContent).toMatchObject({ stdout: encoded, stderr: encoded })
      await client.callTool({ name: 'shell_status', arguments: { jobId } })
      expect(JSON.stringify(records())).not.toContain(encoded)
      expect(readFileSync(config.auditLogPath, 'utf8')).not.toContain(encoded)
      expect(records().find(({ event }) => event === 'shell_job_finished')).toMatchObject({
        payload: { stdoutBytes: encoded.length, stderrBytes: encoded.length, exitCode: 0 },
      })
    },
  )

  it('keeps kubectl metadata independent of a namespace named secrets', async () => {
    const records = captureAudit()
    const { client, config } = await connect()
    const output = JSON.stringify({ kind: 'PodList', items: [] })
    writeFileSync(join(config.workspaceRoot, 'kubectl'), `#!/bin/bash\nprintf '%s' '${output}'\n`, { mode: 0o755 })
    vi.stubEnv('PATH', `${config.workspaceRoot}:${process.env.PATH}`)
    const response = await client.callTool({ name: 'kubectl', arguments: { args: ['get', 'pods', '-n', 'secrets'] } })
    expect(response.structuredContent).toMatchObject({ stdout: output, exitCode: 0 })
    expect(records().find(({ event }) => event === 'tool_call_finished')).toMatchObject({
      payload: { result: { stdout: '[OMITTED]', exitCode: 0 } },
    })
    expect(JSON.stringify(records())).not.toContain('[OMITTED_KUBERNETES_SECRET]')
  })

  it('keeps administrative kubectl operands out of both sinks while preserving MCP results', async () => {
    const records = captureAudit()
    const { client, config } = await connect()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    writeFileSync(join(config.workspaceRoot, 'kubectl'), "#!/bin/bash\nprintf '%s' created\n", { mode: 0o755 })
    vi.stubEnv('PATH', `${config.workspaceRoot}:${process.env.PATH}`)
    for (const args of [
      ['create', 'secret', 'generic', 'demo', '--from-literal=auth=private-literal-value'],
      ['patch', 'secret', 'demo', '-p', '{"data":{"auth.json":"private-patch-value"}}'],
    ]) {
      const response = await client.callTool({ name: 'kubectl_admin', arguments: { args } })
      expect(response.structuredContent).toMatchObject({ stdout: 'created', exitCode: 0 })
    }
    for (const value of ['private-literal-value', 'private-patch-value']) {
      expect(JSON.stringify(records())).not.toContain(value)
      expect(readFileSync(config.auditLogPath, 'utf8')).not.toContain(value)
    }
    expect(records().find(({ event }) => event === 'tool_call_started')).toMatchObject({
      tool: 'kubectl_admin',
      payload: { arguments: '[OMITTED]' },
    })
    expect(records().find(({ event }) => event === 'kubectl_admin')).toMatchObject({
      payload: { command: '[OMITTED]' },
    })
  })

  it('omits search patterns and derived commands while retaining authorized matches', async () => {
    const records = captureAudit()
    const { client, config } = await connect()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    const query = 'syntheticPrivateSearchPattern'
    const matches = `fixture.txt:1:${query}\n`
    writeFileSync(join(config.workspaceRoot, 'rg'), `#!/bin/bash\nprintf '%s' '${matches}'\n`, { mode: 0o755 })
    vi.stubEnv('PATH', `${config.workspaceRoot}:${process.env.PATH}`)
    const response = await client.callTool({ name: 'search', arguments: { query } })
    expect(response.structuredContent).toMatchObject({ ok: true, exitCode: 0, stdout: matches })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')])
      expect(content).not.toContain(query)
    expect(records().find(({ event }) => event === 'tool_call_started')).toMatchObject({
      tool: 'search',
      payload: { arguments: '[OMITTED]' },
    })
    expect(records().find(({ event }) => event === 'search')).toMatchObject({
      payload: { command: '[OMITTED]' },
    })
  })

  it('keeps stdout auditing when the file sink fails', () => {
    const records = captureAudit()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = configFixture()
    config.auditLogPath = config.workspaceRoot
    expect(() => writeAuditLog(config, 'probe', null, {})).not.toThrow()
    expect(records()).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith('[agents-shell] file audit write failed')
  })

  it('keeps the optional file audit when stdout fails without exposing the sink error', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('sensitive-sink-error')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    expect(() => writeAuditLog(config, 'probe', null, { command: '[OMITTED]' })).not.toThrow()
    expect(parseAudit(JSON.parse(readFileSync(config.auditLogPath, 'utf8'))).payload).toEqual({ command: '[OMITTED]' })
    expect(warn).toHaveBeenCalledWith('[agents-shell] stdout audit write failed')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive-sink-error')
  })

  it('logs file access without exporting the file body or changing the MCP response', async () => {
    const records = captureAudit()
    const { client, config } = await connect()
    writeFileSync(join(config.workspaceRoot, 'private-file-name.txt'), 'private-file-content')
    const response = await client.callTool({ name: 'read_file', arguments: { path: 'private-file-name.txt' } })
    expect(response.structuredContent).toMatchObject({ content: 'private-file-content', bytes: 20 })
    const events = records()
    expect(events.map(({ event }) => event)).toEqual(['tool_call_started', 'tool_call_finished'])
    expect(events[0]).toMatchObject({
      requestId: 'request-fixture',
      tool: 'read_file',
      payload: { arguments: '[OMITTED]' },
    })
    expect(events[1]).toMatchObject({
      toolCallId: events[0].toolCallId,
      payload: { outcome: 'succeeded', result: { content: '[OMITTED]' } },
    })
    expect(JSON.stringify(events)).not.toContain('private-file-content')
    expect(JSON.stringify(events)).not.toContain('private-file-name.txt')
  })

  it('uses the same request ID for HTTP metadata and the rejected MCP tool call', async () => {
    const records = captureAudit()
    const handler = createAgentsShellRequestHandler(configFixture())
    const response = await handler(
      new Request('https://agents-shell.example.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'shell_run', arguments: { command: 'echo denied' } },
        }),
      }),
    )
    expect(response.status).toBe(200)
    const [httpLine] =
      vi.mocked(console.log).mock.calls.find(([line]) => String(line).includes('"msg":"agents-shell http request"')) ??
      []
    const http = Schema.decodeUnknownSync(Schema.Struct({ requestId: Schema.String }))(JSON.parse(String(httpLine)))
    expect(records()).toHaveLength(2)
    expect(records().map(({ requestId }) => requestId)).toEqual([http.requestId, http.requestId])
    expect(records()[1]).toMatchObject({ payload: { outcome: 'error' } })
  })

  it('records process failures without exporting stderr bodies', async () => {
    const records = captureAudit()
    const { client } = await connect()
    const response = await client.callTool({
      name: 'shell_run',
      arguments: { command: "printf 'failure detail\\n' >&2; exit 7" },
    })
    expect(response.structuredContent).toMatchObject({ exitCode: 7, stderr: 'failure detail\n' })
    expect(records().find(({ event }) => event === 'tool_call_finished')).toMatchObject({
      payload: { outcome: 'failed', result: { exitCode: 7, stderr: '[OMITTED]' } },
    })
  })

  it('records authorization, input-validation and unknown-tool failures before execution', async () => {
    const records = captureAudit()
    const { client, runner } = await connect(authFixture([]))
    const { client: allowed } = await connect()
    const denied = await client.callTool({ name: 'shell_run', arguments: { command: 'echo denied' } })
    const invalid = await allowed.callTool({ name: 'read_file', arguments: { path: 7 } })
    const unknown = await allowed.callTool({ name: 'not_a_tool', arguments: { token: 'unknown-token-value' } })
    expect(denied.isError).toBe(true)
    expect(invalid.isError).toBe(true)
    expect(unknown.isError).toBe(true)
    expect(runner.jobs.size).toBe(0)
    const events = records()
    expect(events.filter(({ event }) => event === 'tool_call_started')).toHaveLength(3)
    expect(events.filter(({ event }) => event === 'tool_call_finished').map(({ payload }) => payload.outcome)).toEqual([
      'error',
      'error',
      'error',
    ])
    expect(JSON.stringify(events)).not.toContain('unknown-token-value')
  })

  it('does not export invalid authorized arguments or validation-error bodies', async () => {
    const records = captureAudit()
    const { client } = await connect()
    const response = await client.callTool({ name: 'read_file', arguments: { path: ['private-invalid-value'] } })
    expect(response.isError).toBe(true)
    expect(JSON.stringify(response)).toContain('private-invalid-value')
    expect(JSON.stringify(records())).not.toContain('private-invalid-value')
    expect(records()[0]).toMatchObject({ payload: { authorized: true } })
    expect(records()[0].payload).not.toHaveProperty('arguments')
    expect(records()[1].payload).not.toHaveProperty('result')
  })

  it('keeps rejected-call audit metadata independent of arguments and unknown-tool names', async () => {
    const records = captureAudit()
    const { client, runner } = await connect(authFixture([]))
    const denied = await client.callTool({ name: 'shell_run', arguments: { command: 'attacker-data'.repeat(10_000) } })
    const unknown = await client.callTool({
      name: 'unknown-attacker-name'.repeat(1_000),
      arguments: { data: 'attacker-data'.repeat(10_000) },
    })
    expect(denied.isError).toBe(true)
    expect(unknown.isError).toBe(true)
    expect(runner.jobs.size).toBe(0)
    const events = records()
    expect(events).toHaveLength(4)
    expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(1_600)
    expect(JSON.stringify(events)).not.toContain('attacker-data')
    expect(JSON.stringify(events)).not.toContain('unknown-attacker-name')
    expect(
      events.filter(({ event }) => event === 'tool_call_started').map(({ payload }) => payload.authorized),
    ).toEqual([false, false])
    expect(events.filter(({ event }) => event === 'tool_call_finished').map(({ payload }) => payload.outcome)).toEqual([
      'error',
      'error',
    ])
  })

  it('keeps concurrent tool calls and background completion attached to their originating calls', async () => {
    const records = captureAudit()
    const { client, runner } = await connect()
    const [started] = await Promise.all([
      client.callTool({ name: 'shell_start', arguments: { command: "sleep 0.1; printf 'background output\\n'" } }),
      client.callTool({ name: 'shell_run', arguments: { command: "printf 'foreground output\\n'" } }),
    ])
    const { jobId } = parseJob(started.structuredContent)
    await vi.waitFor(() => expect(runner.requireJob(jobId).finishedAt).not.toBeNull(), { timeout: 4_000 })
    const events = records()
    const background = events.find(({ event, tool }) => event === 'tool_call_started' && tool === 'shell_start')
    const foreground = events.find(({ event, tool }) => event === 'tool_call_started' && tool === 'shell_run')
    expect(background?.toolCallId).not.toBe(foreground?.toolCallId)
    expect(events.find(({ event, tool }) => event === 'tool_call_finished' && tool === 'shell_start')).toMatchObject({
      toolCallId: background?.toolCallId,
      payload: { outcome: 'running' },
    })
    expect(
      events.find(({ event, payload }) => event === 'shell_job_finished' && payload.jobId === jobId),
    ).toMatchObject({
      toolCallId: background?.toolCallId,
      requestId: 'request-fixture',
      tool: 'shell_start',
      payload: { stdoutBytes: 18, exitCode: 0 },
    })
    expect(events.find(({ event, tool }) => event === 'tool_call_finished' && tool === 'shell_run')).toMatchObject({
      toolCallId: foreground?.toolCallId,
      payload: { result: { stdout: '[OMITTED]', stdoutBytes: 18 } },
    })
  })

  it('records a completed poll as succeeded while its background job is still running', async () => {
    const records = captureAudit()
    const { client, runner } = await connect()
    const started = await client.callTool({ name: 'shell_start', arguments: { command: 'sleep 10' } })
    const { jobId } = parseJob(started.structuredContent)
    try {
      const response = await client.callTool({ name: 'shell_read', arguments: { jobId } })
      expect(response.structuredContent).toMatchObject({ status: 'running', jobId })
      expect(
        records().find(({ event, tool }) => event === 'tool_call_finished' && tool === 'shell_read'),
      ).toMatchObject({
        payload: { outcome: 'succeeded', result: { status: 'running' } },
      })
    } finally {
      await client.callTool({ name: 'shell_kill', arguments: { jobId } })
      await vi.waitFor(() => expect(runner.requireJob(jobId).finishedAt).not.toBeNull(), { timeout: 4_000 })
    }
  })

  it('records successful shell cancellation and completed-job reads as succeeded', async () => {
    const records = captureAudit()
    const { client, runner } = await connect()
    const started = await client.callTool({ name: 'shell_start', arguments: { command: 'sleep 10' } })
    const { jobId } = parseJob(started.structuredContent)
    const killed = await client.callTool({ name: 'shell_kill', arguments: { jobId } })
    expect(killed.isError).not.toBe(true)
    expect(killed.structuredContent).toMatchObject({ jobId, status: 'killed', ok: false })
    expect(records().find(({ event, tool }) => event === 'tool_call_finished' && tool === 'shell_kill')).toMatchObject({
      payload: { outcome: 'succeeded', result: { jobId, status: 'killed', ok: false } },
    })
    await vi.waitFor(() => expect(runner.requireJob(jobId).finishedAt).not.toBeNull(), { timeout: 4_000 })
    const read = await client.callTool({ name: 'shell_read', arguments: { jobId } })
    expect(read.structuredContent).toMatchObject({ jobId, ok: false })
    expect(records().find(({ event, tool }) => event === 'tool_call_finished' && tool === 'shell_read')).toMatchObject({
      payload: { outcome: 'succeeded', result: { jobId, ok: false } },
    })
    const missing = await client.callTool({ name: 'shell_kill', arguments: { jobId: 'missing-job' } })
    expect(missing.isError).toBe(true)
    expect(records().at(-1)).toMatchObject({
      event: 'tool_call_finished',
      tool: 'shell_kill',
      payload: { outcome: 'error' },
    })
  })

  it('omits Git patterns and commit messages across actual MCP and derived process events', async () => {
    const records = captureAudit()
    const { client, config } = await connect()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    const pattern = 'synthetic-private-git-pattern'
    const message = 'synthetic-private-commit-message'
    await client.callTool({ name: 'git_write', arguments: { args: ['init'] } })
    writeFileSync(join(config.workspaceRoot, 'tracked.txt'), pattern)
    await client.callTool({ name: 'git_write', arguments: { args: ['add', 'tracked.txt'] } })
    const grep = await client.callTool({ name: 'git', arguments: { args: ['grep', pattern] } })
    expect(grep.isError).not.toBe(true)
    expect(JSON.stringify(grep.structuredContent)).toContain(pattern)
    const commit = await client.callTool({
      name: 'git_write',
      arguments: {
        args: [
          '-c',
          'user.name=audit-fixture',
          '-c',
          'user.email=audit@example.test',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-m',
          message,
        ],
      },
    })
    expect(commit.isError).not.toBe(true)
    expect(JSON.stringify(commit.structuredContent)).toContain(message)
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain(pattern)
      expect(content).not.toContain(message)
    }
    expect(records().some(({ event }) => event === 'git_finished')).toBe(true)
  })

  it('omits aliased executable input across actual shell calls and later job reads', async () => {
    const records = captureAudit()
    const { client, config, runner } = await connect()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    const executable = join(config.workspaceRoot, 'credential-client')
    const alias = join(config.workspaceRoot, 'client')
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    symlinkSync(executable, alias)
    const credential = 'synthetic-alias-credential'
    const command = `${alias} -u name:${credential} https://example.test`
    const foreground = await client.callTool({ name: 'shell_run', arguments: { command } })
    expect(foreground.isError).not.toBe(true)
    expect(foreground.structuredContent).toMatchObject({ ok: true, exitCode: 0 })
    expect(JSON.stringify(foreground.structuredContent)).toContain(credential)
    const background = await client.callTool({ name: 'shell_start', arguments: { command } })
    const { jobId } = parseJob(background.structuredContent)
    await vi.waitFor(() => expect(runner.requireJob(jobId).finishedAt).not.toBeNull(), { timeout: 3_000 })
    const read = await client.callTool({ name: 'shell_read', arguments: { jobId } })
    expect(JSON.stringify(read.structuredContent)).toContain(credential)
    const status = await client.callTool({ name: 'shell_status', arguments: { jobId } })
    expect(JSON.stringify(status.structuredContent)).toContain(credential)
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain(credential)
      expect(content).not.toContain(alias)
    }
    expect(records().filter(({ event }) => event === 'shell_job_finished')).toHaveLength(2)
  })

  it('records timeout completion after shell_start has returned', async () => {
    const records = captureAudit()
    const { client, runner } = await connect()
    const started = await client.callTool({
      name: 'shell_start',
      arguments: { command: 'sleep 5', timeoutSeconds: 1 },
    })
    const { jobId } = parseJob(started.structuredContent)
    await vi.waitFor(() => expect(runner.requireJob(jobId).finishedAt).not.toBeNull(), { timeout: 3_000 })
    expect(records().find(({ event }) => event === 'shell_job_finished')).toMatchObject({
      tool: 'shell_start',
      payload: { status: 'timed_out', timedOut: true },
    })
  })
})
