import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  it('emits stdout audit even when the optional file sink is disabled', () => {
    const records = captureAudit()
    writeAuditLog(configFixture(), 'probe', authFixture(), { command: 'pwd', exitCode: 0 })
    expect(records()).toHaveLength(1)
    expect(records()[0]).toMatchObject({
      event: 'probe',
      payload: { command: 'pwd', exitCode: 0 },
      payloadTruncated: false,
    })
    expect(records()[0].subjectHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(records())).not.toContain('test-actor')
    expect(JSON.stringify(records())).not.toContain('actor@example.test')
    expect(JSON.stringify(records())).not.toContain('test-username')
  })

  it('redacts credential fields, known environment secrets, auth strings, URLs and email addresses in both sinks', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    vi.stubEnv('AGENTS_SHELL_TEST_SECRET', 'known-secret-value/with-symbols')
    writeAuditLog(config, 'probe', authFixture(), {
      command:
        'curl -H "Authorization: Bearer arbitrary-bearer-value" --password="quoted password" https://user:password@host.test',
      details: 'known-secret-value/with-symbols known-secret-value%2Fwith-symbols actor@example.test',
      diagnostic: 'API_KEY=unrecognized-key\n--token another-unrecognized-token\nghp_fakeGithubCredentialValue',
      nested: { apiKey: 'typed-key-value', client_secret: 'typed-secret-value' },
      args: ['--token', 'argv-token-value', '-u', 'argv-user:argv-password'],
      connection: 'postgresql://db-user:db-password@host.test/private-db',
      headers: 'curl -H "Authorization: opaque-auth-value" -H "Cookie: session=private-session; other=private-cookie"',
      basicAuth: 'curl -uattached-user:attached-password --user=equals-user:equals-password',
      patch: 'private patch body',
      content: 'private file body',
    })
    const serialized = JSON.stringify(records())
    for (const value of [
      'arbitrary-bearer-value',
      'quoted password',
      'user:password',
      'known-secret-value',
      'actor@example.test',
      'unrecognized-key',
      'another-unrecognized-token',
      'ghp_fakeGithubCredentialValue',
      'typed-key-value',
      'typed-secret-value',
      'argv-token-value',
      'argv-user:argv-password',
      'db-user',
      'private-db',
      'opaque-auth-value',
      'private-session',
      'private-cookie',
      'attached-user',
      'attached-password',
      'equals-user',
      'equals-password',
      'private patch body',
      'private file body',
    ])
      expect(serialized).not.toContain(value)
    expect(serialized).toContain('[REDACTED]')
    expect(serialized).toContain('[OMITTED]')
    expect(JSON.parse(readFileSync(config.auditLogPath, 'utf8'))).toEqual(records()[0])
  })

  it('bounds escaped Unicode output and nested payloads with explicit truncation', () => {
    const records = captureAudit()
    writeAuditLog(configFixture(), 'probe', null, {
      details: '\u0000雪'.repeat(10_000),
      jobs: Array.from({ length: 100 }, (_, i) => ({ command: `job-${i}`, details: 'x'.repeat(10_000) })),
    })
    expect(records()[0].payloadTruncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(records()[0]))).toBeLessThan(16_000)
    expect(JSON.stringify(records())).toContain('[TRUNCATED]')
  })

  it('redacts attached and separate short password options in commands and argument arrays', () => {
    const records = captureAudit()
    writeAuditLog(configFixture(), 'probe', authFixture(), {
      command:
        'mysql -pmysql-password; sshpass -p separate-password ssh -p 2222 host.test; curl -u "quoted-user:quoted password"; docker login -p container-password; redis-cli -a redis-password',
      args: ['-p', 'array-password', '-pattached-array-password'],
    })
    const serialized = JSON.stringify(records())
    for (const value of [
      'mysql-password',
      'separate-password',
      'array-password',
      'attached-array-password',
      'quoted-user',
      'quoted password',
      'container-password',
      'redis-password',
    ])
      expect(serialized).not.toContain(value)
    expect(serialized).toContain('[REDACTED]')
    expect(serialized).toContain('ssh -p 2222')
  })

  it.each([
    { command: 'mkdir -p /workspace/build', args: ['-p', '/workspace/build'] },
    { command: 'git log -p HEAD', args: ['log', '-p', 'HEAD'] },
    { command: 'sort -u input', args: ['-u', 'input'] },
  ])('retains ordinary short options and operands for $command', ({ command, args }) => {
    const records = captureAudit()
    writeAuditLog(configFixture(), 'probe', null, { command, args })
    expect(records()[0].payload).toEqual({ command, args })
  })

  it('bounds audit processing time for a long plain output token', () => {
    const records = captureAudit()
    const startedAt = performance.now()
    writeAuditLog(configFixture(), 'probe', null, {
      details: 'a'.repeat(50_000),
      command: `curl --operation ${'a'.repeat(50_000)}"`,
    })
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(records()[0].payloadTruncated).toBe(true)
  })

  it('omits Kubernetes Secret documents with arbitrary keys and encoded values in both sinks', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    const encoded = Buffer.from('synthetic-unrecognized-credential').toString('base64')
    writeAuditLog(config, 'probe', null, {
      stdout: JSON.stringify({ kind: 'Secret', data: { 'auth.json': encoded } }),
      stderr: `apiVersion: v1\nkind: Secret\ndata:\n  arbitrary: ${encoded}\n`,
      object: { kind: 'SecretList', items: [{ data: { arbitrary: encoded } }] },
    })
    expect(JSON.stringify(records())).not.toContain(encoded)
    expect(JSON.stringify(records())).toContain('[OMITTED_KUBERNETES_SECRET]')
    expect(JSON.parse(readFileSync(config.auditLogPath, 'utf8'))).toEqual(records()[0])
  })

  it('omits AgentRun documents from JSON, YAML and typed payloads', () => {
    const records = captureAudit()
    const body = { kind: 'AgentRun', spec: { implementation: { inline: { text: 'private-agent-task' } } } }
    writeAuditLog(configFixture(), 'probe', null, {
      stdout: JSON.stringify(body),
      stderr: 'apiVersion: agents.proompteng.ai/v1alpha1\nkind: AgentRun\ntext: private-agent-task\n',
      agentRun: body,
    })
    expect(JSON.stringify(records())).not.toContain('private-agent-task')
    expect(JSON.stringify(records())).toContain('[OMITTED_AGENT_RUN]')
  })

  it('keeps delegated task text out of agent_status process and tool audit while retaining the response', async () => {
    const records = captureAudit()
    const { client, config } = await connect()
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
    const response = await client.callTool({ name: 'agent_status', arguments: { agentRunName: 'fixture' } })
    expect(response.structuredContent).toMatchObject({ agentRun })
    for (const value of [
      'private-agent-summary',
      'private-agent-task',
      'private-agent-objective',
      'private-agent-job-task',
    ])
      expect(JSON.stringify(records())).not.toContain(value)
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

  it('redacts long authentication and literal-data options in raw text and argv', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    writeAuditLog(config, 'probe', null, {
      command:
        'curl --proxy-user name:private-proxy-value --oauth2-bearer private-bearer-value -b session=private-cookie-value -E fixture.p12:private-cert-value; kubectl create secret generic demo --from-literal=auth=private-shell-literal',
      args: [
        '--proxy-user',
        'name:private-argv-proxy',
        '--oauth2-bearer=private-argv-bearer',
        '--from-literal',
        'auth=private-argv-literal',
        '-b',
        'session=private-argv-cookie',
        '-E',
        'fixture.p12:private-argv-cert',
      ],
    })
    for (const value of [
      'private-proxy-value',
      'private-bearer-value',
      'private-shell-literal',
      'private-argv-proxy',
      'private-argv-bearer',
      'private-argv-literal',
      'private-cookie-value',
      'private-cert-value',
      'private-argv-cookie',
      'private-argv-cert',
    ]) {
      expect(JSON.stringify(records())).not.toContain(value)
      expect(readFileSync(config.auditLogPath, 'utf8')).not.toContain(value)
    }
  })

  it('redacts kubectl patch data in raw commands with global options and quoted flags', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    const encoded = Buffer.from('synthetic-private-patch').toString('base64')
    const patch = JSON.stringify({ data: { 'auth.json': encoded } })
    for (const command of [
      `kubectl patch secret demo -p '${patch}'`,
      `kubectl --context galactic-tailscale -n bayn patch secret demo "-p" '${patch}'`,
      `kubectl --context=galactic-tailscale --insecure-skip-tls-verify patch secret demo -p '${patch}'`,
    ])
      writeAuditLog(config, 'probe', null, { command })
    expect(JSON.stringify(records())).not.toContain(encoded)
    expect(readFileSync(config.auditLogPath, 'utf8')).not.toContain(encoded)
  })

  it('redacts OpenSSL passphrases in separate and attached command and argv operands', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'openssl pkcs12 -passin pass:synthetic-private-input -passout pass:synthetic-private-output',
      'openssl pkcs12 "-passin" "pass:synthetic-private-input" -passout=pass:synthetic-private-output',
      'openssl pkcs12 "-passin=pass:synthetic-private-input" "-passout=pass:synthetic-private-output"',
      'openssl enc -aes-256-cbc -pass pass:synthetic-private-input',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'openssl',
      args: ['pkcs12', '-passin', 'pass:synthetic-private-input', '-passout=pass:synthetic-private-output'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-private-input')
      expect(content).not.toContain('synthetic-private-output')
    }
    expect(JSON.stringify(records())).toContain('pkcs12')
  })

  it.each([
    {
      command: 'docker login --password-stdin registry.example.test',
      args: ['login', '--password-stdin', 'registry.example.test'],
    },
    { command: 'mysql --skip-password production_db', args: ['--skip-password', 'production_db'] },
  ])('preserves the target after valueless credential switches in $command', ({ command, args }) => {
    const records = captureAudit()
    writeAuditLog(configFixture(), 'probe', null, { command, args })
    expect(records()[0].payload).toEqual({ command, args })
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
    expect(() => writeAuditLog(config, 'probe', null, { command: 'pwd' })).not.toThrow()
    expect(parseAudit(JSON.parse(readFileSync(config.auditLogPath, 'utf8'))).payload).toEqual({ command: 'pwd' })
    expect(warn).toHaveBeenCalledWith('[agents-shell] stdout audit write failed')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive-sink-error')
  })

  it('logs file access without exporting the file body or changing the MCP response', async () => {
    const records = captureAudit()
    const { client, config } = await connect()
    writeFileSync(join(config.workspaceRoot, 'hello.txt'), 'private-file-content')
    const response = await client.callTool({ name: 'read_file', arguments: { path: 'hello.txt' } })
    expect(response.structuredContent).toMatchObject({ content: 'private-file-content', bytes: 20 })
    const events = records()
    expect(events.map(({ event }) => event)).toEqual(['tool_call_started', 'tool_call_finished'])
    expect(events[0]).toMatchObject({
      requestId: 'request-fixture',
      tool: 'read_file',
      payload: { arguments: { path: 'hello.txt' } },
    })
    expect(events[1]).toMatchObject({
      toolCallId: events[0].toolCallId,
      payload: { outcome: 'succeeded', result: { content: '[OMITTED]' } },
    })
    expect(JSON.stringify(events)).not.toContain('private-file-content')
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
