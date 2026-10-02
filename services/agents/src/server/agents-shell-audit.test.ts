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

  it('redacts credentials inside grouped short options in commands and argv', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'curl -suadmin:syntheticGroupedCredential https://example.test',
      "'/usr/bin/cu'\"rl\" '-sLuadmin:syntheticGroupedCredential' https://example.test",
      'curl -sUproxyuser:syntheticGroupedCredential https://example.test',
      'curl -sbcookie=syntheticGroupedCredential https://example.test',
      'curl -sEsyntheticGroupedCredential https://example.test',
      'mysql -vpsyntheticGroupedCredential',
      'ssh-keygen -qNsyntheticGroupedCredential -f fixture.key',
    ])
      writeAuditLog(config, 'probe', null, { command })
    for (const args of [
      ['-suadmin:syntheticGroupedCredential', 'https://example.test'],
      ['-sLu', 'admin:syntheticGroupedCredential', 'https://example.test'],
      ['-sUproxyuser:syntheticGroupedCredential', 'https://example.test'],
      ['-uadmin:syntheticGroupedCredential', 'https://example.test'],
    ])
      writeAuditLog(config, 'probe', null, { command: 'curl', args })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticGroupedCredential')
      expect(content).not.toContain('proxyuser')
      expect(content).toContain('[REDACTED]')
    }
    writeAuditLog(config, 'probe', null, {
      command: 'curl -svf https://example.test',
      args: ['-svf', 'https://example.test'],
    })
    expect(records().at(-1)?.payload).toEqual({
      command: 'curl -svf https://example.test',
      args: ['-svf', 'https://example.test'],
    })
    writeAuditLog(config, 'probe', null, { command: 'curl -sooutput.txt https://example.test' })
    expect(records().at(-1)?.payload.command).toBe('curl -sooutput.txt https://example.test')
  })

  it('omits HTTP body operands inside curl short-option groups', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'curl -LsdsyntheticGroupedBody https://example.test',
      "'/usr/bin/cu'\"rl\" '-sF' 'custom=syntheticGroupedBody' https://example.test",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'curl',
      args: ['-Lsd', 'syntheticGroupedBody', 'https://example.test'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticGroupedBody')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
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
    for (const token of ['a'.repeat(50_000), 'a-'.repeat(25_000), 'curl '.repeat(10_000)])
      writeAuditLog(configFixture(), 'probe', null, {
        details: token,
        command: `curl --operation ${token}"`,
      })
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(records().every((record) => record.payloadTruncated)).toBe(true)
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

  it('preserves Kubernetes Secret resource names and flags while redacting data assignments', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of ['kubectl get secret demo -n agents', 'kubectl get secrets -n agents', 'k get secret demo']) {
      writeAuditLog(config, 'probe', null, { command })
      expect(records().at(-1)?.payload.command).toBe(command)
    }
    writeAuditLog(config, 'probe', null, { command: 'kubectl', args: ['get', 'secrets', '-n', 'agents'] })
    expect(records().at(-1)?.payload.args).toEqual(['get', 'secrets', '-n', 'agents'])
    writeAuditLog(config, 'probe', null, { details: 'secret=syntheticAssignment; password: syntheticAssignment' })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticAssignment')
      expect(content).toContain('kubectl get secret demo -n agents')
      expect(content).toContain('kubectl get secrets -n agents')
    }
  })

  it('uses the kubectl credential policy for the repository k alias', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    const encoded = Buffer.from('synthetic-private-alias-patch').toString('base64')
    const patch = JSON.stringify({ data: { 'auth.json': encoded } })
    for (const command of [
      `k patch secret demo -p '${patch}'`,
      `'/usr/local/bin/k' --context galactic-tailscale -n agents patch secret demo "-p" '${patch}'`,
      `k --context=galactic-tailscale patch secret demo -p='${patch}'`,
      `k patch secret demo '-p${patch}'`,
      `remote-runner 'env k patch secret demo -p ${encoded}'`,
    ])
      writeAuditLog(config, 'probe', null, { command })
    for (const args of [
      ['patch', 'secret', 'demo', '-p', patch],
      ['--context', 'galactic-tailscale', '-n', 'agents', 'patch', 'secret', 'demo', `-p=${patch}`],
    ])
      writeAuditLog(config, 'probe', null, { command: '/usr/local/bin/k', args })
    writeAuditLog(config, 'probe', null, { command: 'k --token syntheticAliasToken -n agents get pods' })
    expect(records().at(-1)?.payload.command).toBe('k --token [REDACTED] -n agents get pods')
    writeAuditLog(config, 'probe', null, { command: 'k', args: ['--token', 'syntheticAliasToken', 'get', 'pods'] })
    expect(records().at(-1)?.payload.args).toEqual(['--token', '[REDACTED]', 'get', 'pods'])
    writeAuditLog(config, 'probe', null, { command: 'k', args: ['apply', '-f', '-'] })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain(encoded)
      expect(content).not.toContain('syntheticAliasToken')
      expect(content).toContain('[REDACTED]')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
    writeAuditLog(config, 'probe', null, { command: 'k -n agents get pods', args: ['get', 'pods'] })
    expect(records().at(-1)?.payload).toEqual({ command: 'k -n agents get pods', args: ['get', 'pods'] })
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
      'openssl enc -aes-256-cbc -k synthetic-private-input -K synthetic-private-output -kfile fixture.pwd',
      'gpg --batch --passphrase synthetic-private-input',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'openssl',
      args: ['pkcs12', '-passin', 'pass:synthetic-private-input', '-passout=pass:synthetic-private-output'],
    })
    writeAuditLog(config, 'probe', null, {
      command: 'openssl',
      args: ['enc', '-k', 'synthetic-private-input', '-K', 'synthetic-private-output', '-kfile', 'fixture.pwd'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-private-input')
      expect(content).not.toContain('synthetic-private-output')
    }
    expect(JSON.stringify(records())).toContain('pkcs12')
    expect(JSON.stringify(records())).toContain('-kfile fixture.pwd')
  })

  it('omits OpenSSL password-generation input and redacts TLS PSK and SRP credentials', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'openssl passwd syntheticOpenSSLInput',
      '\'/usr/bin/open\'"ssl" -provider default passwd -6 syntheticOpenSSLInput',
      'openssl s_client -connect example.test:443 -psk syntheticOpenSSLInput',
      'openssl s_client -psk=syntheticOpenSSLInput',
      'openssl s_client -srppass syntheticOpenSSLInput -srpuser syntheticOpenSSLInput',
      'openssl s_server -psk_identity syntheticOpenSSLInput',
    ])
      writeAuditLog(config, 'probe', null, { command })
    for (const args of [
      ['passwd', '-6', 'syntheticOpenSSLInput'],
      ['s_client', '-connect', 'example.test:443', '-psk', 'syntheticOpenSSLInput'],
      ['s_client', '-srppass', 'syntheticOpenSSLInput', '-srpuser', 'syntheticOpenSSLInput'],
    ])
      writeAuditLog(config, 'probe', null, { command: 'openssl', args })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticOpenSSLInput')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
      expect(content).toContain('example.test:443')
    }
    writeAuditLog(config, 'probe', null, { command: 'openssl version' })
    expect(records().at(-1)?.payload.command).toBe('openssl version')
  })

  it('redacts OpenSSL MAC and key derivation operands in raw commands and argv', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'openssl dgst -sha256 -hmac synthetic-private-hmac fixture.txt',
      '"/usr/bin/openssl" dgst "-hmac" "synthetic-private-hmac" fixture.txt',
      'openssl mac -macopt key:synthetic-private-hmac HMAC',
      'openssl kdf -kdfopt hexkey:synthetic-private-hmac HKDF',
      'openssl pkeyutl -pkeyopt hexkey:synthetic-private-hmac -pkeyopt_passin secret:synthetic-private-hmac',
      'openssl dgst -sigopt key:synthetic-private-hmac fixture.txt',
      'openssl dgst -hmac-stdin fixture.txt',
      'openssl dgst -hmac-env KEY_ENV_VAR fixture.txt',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'openssl',
      args: [
        'dgst',
        '-sha256',
        '-hmac',
        'synthetic-private-hmac',
        '-macopt',
        'hexkey:synthetic-private-hmac',
        'fixture.txt',
      ],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-private-hmac')
      expect(content).toContain('fixture.txt')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
      expect(content).toContain('-hmac-env KEY_ENV_VAR fixture.txt')
    }
  })

  it('omits shell credential-input commands and argv without parsing their input', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "docker login --password-stdin registry.example <<< 'synthetic-private-stdin'",
      "printf 'synthetic-private-stdin' | docker login --password-stdin registry.example",
      'docker login --pass"word"-stdin registry.example <<EOF\nsynthetic-private-stdin\nEOF',
      "docker login --pass\\word-stdin registry.example <<< 'synthetic-private-stdin'",
      "printf 'synthetic-private-stdin' | openssl dgst -hmac-stdin fixture.txt",
      "printf 'synthetic-private-stdin' | openssl enc -passin stdin",
      "printf 'synthetic-private-stdin' | openssl enc -passin fd:0",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'bash',
      args: ['-c', "docker login --password-stdin registry.example <<< 'synthetic-private-stdin'"],
    })
    writeAuditLog(config, 'probe', null, {
      command: 'docker',
      args: ['login', '--password-stdin', 'registry.example', 'synthetic-private-stdin'],
      stdin: 'synthetic-private-stdin',
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-private-stdin')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
  })

  it('redacts OpenSSL cipher aliases without confusing key-file options', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    writeAuditLog(config, 'probe', null, {
      command: 'openssl aes-256-cbc -k synthetic-cipher-password -K synthetic-cipher-key -kfile fixture.pwd',
    })
    writeAuditLog(config, 'probe', null, {
      command: '"/usr/bin/openssl"',
      args: ['aes-256-cbc', '-k', 'synthetic-cipher-password', '-K', 'synthetic-cipher-key', '-kfile', 'fixture.pwd'],
    })
    writeAuditLog(config, 'probe', null, { command: 'openssl x509 -key fixture.pem -in certificate.pem' })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-cipher-password')
      expect(content).not.toContain('synthetic-cipher-key')
      expect(content).toContain('-kfile fixture.pwd')
      expect(content).toContain('openssl x509 -key fixture.pem -in certificate.pem')
    }
  })

  it('omits inline shell bodies and stdin sources independent of their program', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "kubectl create secret generic demo --from-file=token=/dev/stdin <<< 'synthetic-inline-body'",
      "printf 'synthetic-inline-body' | kubectl create secret generic demo --from-file=token=/dev/stdin",
      "printf 'synthetic-inline-body' | kubectl create secret generic demo --from-file=token=/dev/fd/0",
      "printf 'synthetic-inline-body' | kubectl apply -f -",
      'cat <<EOF\nsynthetic-inline-body\nEOF',
      "curl --data-binary @<(printf 'synthetic-inline-body') https://example.test",
      "openssl dgst -macopt key:$(printf 'synthetic-inline-body') fixture.txt",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'kubectl',
      args: ['create', 'secret', 'generic', 'demo', '--from-file=token=/dev/stdin', 'synthetic-inline-body'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-inline-body')
      expect(content).toContain('[OMITTED_')
    }
  })

  it('omits curl stdin configuration input while retaining configuration file paths', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "printf 'user = admin:synthetic-curl-config' | curl --config -",
      "printf 'user = admin:synthetic-curl-config' | curl -K -",
      "printf 'user = admin:synthetic-curl-config' | '/usr/bin/curl' '--config=-'",
      "printf 'user = admin:synthetic-curl-config' | curl -K-",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'curl',
      args: ['--config', '-', 'synthetic-curl-config'],
    })
    writeAuditLog(config, 'probe', null, { command: 'curl --config fixture.conf https://example.test' })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-curl-config')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
      expect(content).toContain('curl --config fixture.conf https://example.test')
    }
  })

  it('omits curl request bodies independently of JSON shell escaping', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      String.raw`curl -d "{\"password\":\"synthetic-request-body\"}" https://example.test`,
      "curl --data-raw='synthetic-request-body' https://example.test",
      'cu\'\'rl --json \'{"message":"synthetic-request-body"}\' https://example.test',
      'curl -dsynthetic-request-body https://example.test',
      "curl -F 'message=synthetic-request-body' https://example.test",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'curl',
      args: ['--data', '{"password":"synthetic-request-body"}', 'https://example.test'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-request-body')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
  })

  it('omits named HTTP request-body inputs across commands while retaining GET targets', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'wget --post-data=\'{"ssn":"synthetic-personal-body"}\' https://example.test',
      "wget --body-data 'synthetic-personal-body' --method=PUT https://example.test",
      "wg''et --po''st-data=synthetic-personal-body https://example.test",
      "http --raw 'synthetic-personal-body' POST https://example.test",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'wget',
      args: ['--body-data', 'synthetic-personal-body', 'https://example.test'],
    })
    writeAuditLog(config, 'probe', null, { command: 'wget --quiet https://example.test' })
    writeAuditLog(config, 'probe', null, { command: 'git diff --raw HEAD' })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-personal-body')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
      expect(content).toContain('wget --quiet https://example.test')
      expect(content).toContain('git diff --raw HEAD')
    }
    expect(
      records()
        .slice(0, -2)
        .every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]'),
    ).toBe(true)
  })

  it('omits explicit body arguments and GitHub secret operations', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'gh secret set DEPLOY_KEY --body synthetic-github-secret',
      'gh secret set DEPLOY_KEY -b synthetic-github-secret',
      "'/usr/bin/gh' --hostname example.test se''cret set DEPLOY_KEY -bsynthetic-github-secret",
      'gh api repos/owner/repo/actions/secrets/DEPLOY_KEY --method PUT -f encrypted_value=synthetic-github-secret',
      'gh pr create --body=synthetic-github-secret',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'gh',
      args: ['secret', 'set', 'DEPLOY_KEY', '-b', 'synthetic-github-secret'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-github-secret')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
  })

  it('omits GitHub authentication input without parsing concatenated tokens', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "printf 'ghp_'syntheticAuthInputValue | gh auth login --with-token",
      "printf 'ghp_'syntheticAuthInputValue | '/usr/bin/gh' --hostname example.test au''th login --with-token",
      "printf 'ghp_'syntheticAuthInputValue | gh auth refresh --with-token",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'gh',
      args: ['auth', 'login', '--with-token', 'syntheticAuthInputValue'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticAuthInputValue')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
  })

  it('omits Git credential protocol commands and helpers in both sinks', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "printf 'password=%s\\n\\n' syntheticGitProtocolValue | git credential approve",
      '\'/usr/bin/gi\'"t" -C /workspace credential reject syntheticGitProtocolValue',
      'git credential-store store syntheticGitProtocolValue',
      'git-credential-cache store syntheticGitProtocolValue',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'git',
      args: ['credential', 'fill', 'syntheticGitProtocolValue'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticGitProtocolValue')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
  })

  it('omits opaque pipeline input without classifying its receiving program', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "printf '%s' syntheticPipelineInput | arbitrary-input-reader",
      'printf syntheticPipelineInput |& arbitrary-input-reader',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'bash',
      args: ['-c', "printf '%s' syntheticPipelineInput | arbitrary-input-reader"],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticPipelineInput')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
    writeAuditLog(config, 'probe', null, { command: 'git status || git diff' })
    expect(records().at(-1)?.payload.command).toBe('git status || git diff')
  })

  it('omits shell expansions that dynamically select executables, options and operations', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'client=curl; "$client" -u admin:syntheticDynamicCredential https://example.test',
      'client=curl; "${client}" -uadmin:syntheticDynamicCredential https://example.test',
      '"${client:-curl}" -u admin:syntheticDynamicCredential https://example.test',
      'option=-u; curl "$option" admin:syntheticDynamicCredential https://example.test',
      'operation=api; gh "$operation" repos/owner/repo/issues -f body=syntheticDynamicCredential',
      '"$1" -u admin:syntheticDynamicCredential https://example.test',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: '$client',
      args: ['-u', 'admin:syntheticDynamicCredential', 'https://example.test'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticDynamicCredential')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
    writeAuditLog(config, 'probe', null, { command: 'curl https://example.test --head' })
    expect(records().at(-1)?.payload.command).toBe('curl https://example.test --head')
  })

  it('omits GitHub API payload fields while retaining plain GET targets', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "gh api repos/owner/repo/issues -f body='syntheticApiBody private text'",
      "gh api repos/owner/repo/issues -Fbody='syntheticApiBody private text'",
      "gh api --method POST repos/owner/repo/issues --raw-field=body='syntheticApiBody private text'",
      "'/usr/bin/g'\"h\" --hostname example.test a''pi repos/owner/repo/issues '--fi'\"eld\" 'body=syntheticApiBody private text'",
      'gh api repos/owner/repo/issues --input=syntheticApiBody.json',
      String.raw`gh \
api repos/owner/repo/issues \
-f body='syntheticApiBody private text'`,
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'gh',
      args: ['api', 'repos/owner/repo/issues', '-f', 'body=syntheticApiBody private text'],
    })
    writeAuditLog(config, 'probe', null, { command: 'gh', args: ['api', 'repos/owner/repo/issues', '--input', '-'] })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticApiBody')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
    writeAuditLog(config, 'probe', null, { command: 'gh api repos/owner/repo/issues --method GET --paginate' })
    expect(records().at(-1)?.payload.command).toBe('gh api repos/owner/repo/issues --method GET --paginate')
    writeAuditLog(config, 'probe', null, { command: 'gh repo view --json name --jq .name' })
    expect(records().at(-1)?.payload.command).toBe('gh repo view --json name --jq .name')
  })

  it('redacts ssh-keygen passphrases without masking SSH and SCP port operands', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'ssh-keygen -t ed25519 -N syntheticNewKeyPassphrase -f fixture.key',
      'ssh-keygen -p -P syntheticOldKeyPassphrase -N syntheticNewKeyPassphrase -f fixture.key',
      "'/usr/bin/ssh-key'\"gen\" '-PsyntheticOldKeyPassphrase' '-NsyntheticNewKeyPassphrase' -f fixture.key",
      'ssh-keygen -N=syntheticNewKeyPassphrase -f fixture.key',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'ssh-keygen',
      args: ['-p', '-P', 'syntheticOldKeyPassphrase', '-N', 'syntheticNewKeyPassphrase', '-f', 'fixture.key'],
    })
    writeAuditLog(config, 'probe', null, { command: 'ssh -p 2222 example.test' })
    writeAuditLog(config, 'probe', null, { command: 'scp -P2222 example.test:fixture.txt fixture.txt' })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticOldKeyPassphrase')
      expect(content).not.toContain('syntheticNewKeyPassphrase')
      expect(content).toContain('fixture.key')
      expect(content).toContain('ssh -p 2222 example.test')
      expect(content).toContain('scp -P2222 example.test:fixture.txt fixture.txt')
      expect(content).toContain('[REDACTED]')
    }
  })

  it('redacts URI credentials across protocols while preserving plain server addresses', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const protocol of ['nats', 'tls', 'ftp', 'sftp', 'smtp', 'amqp', 'mqtt', 'https']) {
      writeAuditLog(config, 'probe', null, {
        command: `client --server ${protocol}://user:syntheticUriPassword!part@example.test:4222/path`,
      })
      writeAuditLog(config, 'probe', null, {
        command: 'client',
        args: ['--server', `${protocol}://syntheticUriToken!part@example.test:4222/path`],
      })
    }
    writeAuditLog(config, 'probe', null, { command: 'nats --server nats://example.test:4222 server info' })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticUriPassword')
      expect(content).not.toContain('syntheticUriToken')
      expect(content).toContain('[REDACTED]@example.test:4222/path')
      expect(content).toContain('nats --server nats://example.test:4222 server info')
    }
  })

  it('redacts curl user information in scheme-less URLs', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'curl operator:syntheticNoSchemeValue@127.0.0.1:8080/path',
      'curl --url operator:syntheticNoSchemeValue@localhost:8080/path',
      'curl --url=operator:syntheticNoSchemeValue@localhost:8080/path',
      "curl 'operator:syntheticNoScheme!'Value@localhost:8080/path",
      'curl syntheticNoSchemeValue@localhost:8080/path',
      'env curl operator:syntheticNoSchemeValue@localhost:8080/path',
    ])
      writeAuditLog(config, 'probe', null, { command })
    for (const args of [
      ['--url', 'operator:syntheticNoSchemeValue@localhost:8080/path'],
      ['--url=operator:syntheticNoSchemeValue@localhost:8080/path'],
      ['syntheticNoSchemeValue@localhost:8080/path'],
    ])
      writeAuditLog(config, 'probe', null, { command: 'curl', args })
    writeAuditLog(config, 'probe', null, {
      command: 'sshpass',
      args: ['-p', 'syntheticNoSchemeValue', 'curl', 'operator:syntheticNoSchemeValue@localhost:8080/path'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticNoScheme')
      expect(content).not.toContain('operator:')
      expect(content).toContain('[REDACTED]@localhost:8080/path')
    }
    writeAuditLog(config, 'probe', null, { command: 'curl --url localhost:8080/path' })
    expect(records().at(-1)?.payload.command).toBe('curl --url localhost:8080/path')
  })

  it('omits URLs with query or fragment input independent of credential parameter names', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "curl 'https://example.test/download?access_token=syntheticQueryBody'",
      "curl --url 'https://example.test/download?X-Amz-Signature=syntheticQueryBody&X-Amz-Credential=other-value'",
      "curl 'https://example.test/download?custom='syntheticQueryBody",
      "curl 'https://example.test/download#access_token=syntheticQueryBody'",
      "client 'custom+tls://example.test/path?opaque_key=syntheticQueryBody'",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'curl',
      args: ['--url', 'https://example.test/download?api%5Fkey=syntheticQueryBody'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticQueryBody')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
    writeAuditLog(config, 'probe', null, { command: 'curl https://example.test/download' })
    expect(records().at(-1)?.payload.command).toBe('curl https://example.test/download')
  })

  it('omits relative API query and fragment input independent of URL schemes', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "gh api 'search/issues?q=syntheticRelativeQuery&access_token=opaque-value'",
      "gh --hostname github.test api '/endpoint#syntheticRelativeQuery'",
      "'/usr/bin/g'\"h\" api 'search/issues?q='syntheticRelativeQuery",
      "curl 'example.test/endpoint?q=syntheticRelativeQuery'",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, { command: 'gh', args: ['api', 'search/issues?q=syntheticRelativeQuery'] })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticRelativeQuery')
      expect(content).not.toContain('opaque-value')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
    writeAuditLog(config, 'probe', null, { command: 'gh api repos/owner/repo' })
    expect(records().at(-1)?.payload.command).toBe('gh api repos/owner/repo')
  })

  it('omits unresolved brace and glob inputs before matching credential commands', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      '{cu,}rl -u admin:syntheticExpandedCredential https://example.test',
      '/usr/bin/c[u]rl -u admin:syntheticExpandedCredential https://example.test',
      '/usr/bin/cu*l -u admin:syntheticExpandedCredential https://example.test',
      "printf '%s' '{cu,}rl -u admin:syntheticExpandedCredential'",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: '{cu,}rl',
      args: ['-u', 'admin:syntheticExpandedCredential', 'https://example.test'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticExpandedCredential')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
    writeAuditLog(config, 'probe', null, { command: 'curl https://example.test' })
    expect(records().at(-1)?.payload.command).toBe('curl https://example.test')
  })

  it('omits grouped shell command bodies before matching credential commands', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      '(curl -u admin:syntheticSubshellCredential https://example.test)',
      '(curl -uadmin:syntheticSubshellCredential https://example.test)',
      'true && (mysql -psyntheticSubshellCredential)',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: '(curl',
      args: ['-u', 'admin:syntheticSubshellCredential', 'https://example.test)'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticSubshellCredential')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
  })

  it('omits multiline shell input before credential option redaction', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'curl -u\\\n admin:syntheticContinuedCredential https://example.test',
      'curl -u\\\r\n admin:syntheticContinuedCredential https://example.test',
      'cu\\\nrl -u admin:syntheticContinuedCredential https://example.test',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'curl',
      args: ['-u\\\n', 'admin:syntheticContinuedCredential', 'https://example.test'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticContinuedCredential')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
  })

  it('omits inline agent runner task input in raw commands and argv', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "cx-codex-run 'syntheticPrivateTaskBody'",
      "'/usr/local/bin/cx-codex-run' --model test-model 'syntheticPrivateTaskBody'",
      "codex exec 'syntheticPrivateTaskBody'",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, { command: 'cx-codex-run', args: ['syntheticPrivateTaskBody'] })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticPrivateTaskBody')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
  })

  it('omits curl flags that construct query input without a literal URL query', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const option of ['--url-query', '--request-target']) {
      for (const command of [
        `curl ${option} signature=syntheticConstructedQuery https://example.test`,
        `curl ${option}=signature=syntheticConstructedQuery https://example.test`,
        `curl '${option}' 'signature=syntheticConstructedQuery' https://example.test`,
        `curl '${option.slice(0, 5)}'"${option.slice(5)}" signature=syntheticConstructedQuery https://example.test`,
      ])
        writeAuditLog(config, 'probe', null, { command })
      for (const args of [
        [option, 'signature=syntheticConstructedQuery', 'https://example.test'],
        [`${option}=signature=syntheticConstructedQuery`, 'https://example.test'],
      ])
        writeAuditLog(config, 'probe', null, { command: 'curl', args })
    }
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticConstructedQuery')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
    writeAuditLog(config, 'probe', null, { command: 'curl --url https://example.test/download' })
    expect(records().at(-1)?.payload.command).toBe('curl --url https://example.test/download')
  })

  it('omits explicit interpreter code bodies while retaining script-file paths', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "bash -lc 'curl -u admin:syntheticInterpreterBody https://example.test'",
      "'/bin/ba'\"sh\" --norc --command='printf syntheticInterpreterBody'",
      'python3.12 -Ic \'print("syntheticInterpreterBody")\'',
      'node --eval=\'process.stdout.write("syntheticInterpreterBody")\'',
      'node -pe \'"syntheticInterpreterBody"\'',
      'bun -e \'console.log("syntheticInterpreterBody")\'',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'python3',
      args: ['-c', 'print("syntheticInterpreterBody")'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticInterpreterBody')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
    for (const command of ['bash fixture.sh', 'python3 fixture.py', 'node fixture.js', 'bun run fixture.ts']) {
      writeAuditLog(config, 'probe', null, { command })
      expect(records().at(-1)?.payload.command).toBe(command)
    }
  })

  it('omits quoted nested credential commands without depending on the outer executable', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "ssh example.test 'curl -u admin:syntheticNestedBody https://example.test'",
      'ssh example.test "redis-cli -a syntheticNestedBody ping"',
      "remote-runner 'sshpass -p syntheticNestedBody ssh example.test'",
      "remote-runner '/usr/bin/curl -u admin:syntheticNestedBody https://example.test'",
      "ssh example.test 'env curl -u admin:syntheticNestedBody https://example.test'",
      "ssh example.test 'timeout 5 env -i nice -n10 curl -u admin:syntheticNestedBody https://example.test'",
      "remote-runner 'true;env /usr/bin/curl -u admin:syntheticNestedBody https://example.test'",
      "remote-runner 'if true; then curl -u admin:syntheticNestedBody https://example.test; fi'",
    ])
      writeAuditLog(config, 'probe', null, { command })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticNestedBody')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    for (const command of ["cat '/tmp/file with spaces'", "echo 'ordinary words'", 'ssh -p2222 example.test']) {
      writeAuditLog(config, 'probe', null, { command })
      expect(records().at(-1)?.payload.command).toBe(command)
    }
  })

  it('omits shell builtin command bodies in both sinks', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "eval 'curl -u admin:syntheticEvalBody https://example.test'",
      "builtin ev''al -- 'curl -u admin:syntheticEvalBody https://example.test'",
      String.raw`e\val 'curl -u admin:syntheticEvalBody https://example.test'`,
      "trap 'curl -u admin:syntheticEvalBody https://example.test' EXIT",
      "alias fixture='curl -u admin:syntheticEvalBody https://example.test'",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'eval',
      args: ['curl -u admin:syntheticEvalBody https://example.test'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticEvalBody')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    expect(records().at(-1)?.payload.args).toBe('[OMITTED_SHELL_INPUT]')
  })

  it('preserves Wget targets after valueless cookie switches', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const option of ['--no-cookies', '--keep-session-cookies']) {
      const command = `wget ${option} https://example.test/file`
      writeAuditLog(config, 'probe', null, { command })
      expect(records().at(-1)?.payload.command).toBe(command)
      writeAuditLog(config, 'probe', null, { command: 'wget', args: [option, 'https://example.test/file'] })
      expect(records().at(-1)?.payload.args).toEqual([option, 'https://example.test/file'])
    }
    writeAuditLog(config, 'probe', null, {
      command: 'wget --load-cookies syntheticCookiePath https://example.test/file',
    })
    writeAuditLog(config, 'probe', null, {
      command: 'wget',
      args: ['--load-cookies', 'syntheticCookiePath', 'https://example.test/file'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticCookiePath')
      expect(content).toContain('https://example.test/file')
    }
  })

  it('omits embedded SSH command bodies without changing ordinary proxy jumps', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      "ssh -oProxyCommand='sshpass -p syntheticProxyBody ssh gateway nc %h %p' example.test",
      "ssh -o 'ProxyCommand=sshpass -p syntheticProxyBody ssh gateway nc %h %p' example.test",
      "ssh -o 'RemoteCommand=curl -u admin:syntheticProxyBody https://example.test' example.test",
      "ssh -oLocalCommand='curl -u admin:syntheticProxyBody https://example.test' -oPermitLocalCommand=yes example.test",
      "ssh -o 'KnownHostsCommand=curl -u admin:syntheticProxyBody https://example.test' example.test",
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'ssh',
      args: ['-o', 'ProxyCommand=sshpass -p syntheticProxyBody ssh gateway nc %h %p', 'example.test'],
    })
    for (const option of ['RemoteCommand', 'LocalCommand', 'KnownHostsCommand'])
      writeAuditLog(config, 'probe', null, {
        command: 'ssh',
        args: ['-o', `${option}=curl -u admin:syntheticProxyBody https://example.test`, 'example.test'],
      })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('syntheticProxyBody')
      expect(content).toContain('[OMITTED_SHELL_INPUT]')
    }
    expect(records().every((record) => record.payload.command === '[OMITTED_SHELL_INPUT]')).toBe(true)
    writeAuditLog(config, 'probe', null, { command: 'ssh -oProxyJump=gateway -p2222 example.test' })
    expect(records().at(-1)?.payload.command).toBe('ssh -oProxyJump=gateway -p2222 example.test')
  })

  it('preserves valueless user switches outside credential-owning commands', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    writeAuditLog(config, 'probe', null, { command: 'systemctl --user status demo.service' })
    writeAuditLog(config, 'probe', null, { command: 'pip install --user fixture-package' })
    writeAuditLog(config, 'probe', null, { command: 'systemctl', args: ['--user', 'status', 'demo.service'] })
    writeAuditLog(config, 'probe', null, { command: 'curl --user admin:synthetic-user-password https://example.test' })
    writeAuditLog(config, 'probe', null, { command: 'curl', args: ['--user=admin:synthetic-user-password'] })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).toContain('systemctl --user status demo.service')
      expect(content).toContain('pip install --user fixture-package')
      expect(content).toContain('"--user","status","demo.service"')
      expect(content).not.toContain('synthetic-user-password')
      expect(content).toContain('https://example.test')
    }
  })

  it('redacts container login passwords after global options without masking published ports', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'docker --context remote login -p synthetic-container-password registry.test',
      'docker --context=remote --debug login -psynthetic-container-password registry.test',
      '"/usr/bin/docker" "--config" "/tmp/config with spaces" "login" "-p" "synthetic-container-password" registry.test',
      'podman --root /tmp/root login -p synthetic-container-password registry.test',
      'podman --root=/tmp/root --remote login -p=synthetic-container-password registry.test',
    ])
      writeAuditLog(config, 'probe', null, { command })
    for (const [command, option, value] of [
      ['docker', '--context', 'remote'],
      ['podman', '--root', '/tmp/root'],
    ])
      writeAuditLog(config, 'probe', null, {
        command,
        args: [option, value, 'login', '-p', 'synthetic-container-password', 'registry.test'],
      })
    writeAuditLog(config, 'probe', null, {
      command: 'docker --context remote login',
      args: ['-p', 'synthetic-container-password', 'registry.test'],
    })
    writeAuditLog(config, 'probe', null, { command: 'docker --context remote run -p 8080:80 fixture' })
    writeAuditLog(config, 'probe', null, {
      command: 'podman',
      args: ['--root', '/tmp/root', 'run', '-p', '8080:80', 'fixture'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-container-password')
      expect(content).toContain('registry.test')
      expect(content).toContain('docker --context remote run -p 8080:80 fixture')
      expect(content).toContain('8080:80')
    }
  })

  it('redacts credentials after concatenated and escaped executable names and options', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'cu""rl -u admin:synthetic-concatenated-value https://example.test',
      "cu''rl -U admin:synthetic-concatenated-value https://example.test",
      String.raw`/usr/bin/cu\rl -\u admin:synthetic-concatenated-value https://example.test`,
      'dock""er --context remote lo""gin -p synthetic-concatenated-value registry.test',
      String.raw`my\sql -\psynthetic-concatenated-value database`,
      'open""ssl aes-256-cbc -k synthetic-concatenated-value -in fixture.txt',
      'printf example; cu""rl -u admin:synthetic-concatenated-value https://example.test | sort -u',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'cu""rl',
      args: ['-u', 'admin:synthetic-concatenated-value', 'https://example.test'],
    })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).not.toContain('synthetic-concatenated-value')
      expect(content).toContain('https://example.test')
      expect(content).toContain('registry.test')
      expect(content).toContain('fixture.txt')
    }
  })

  it('preserves curl targets after its valueless cookie switch', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    writeAuditLog(config, 'probe', null, { command: 'curl --junk-session-cookies https://example.test' })
    writeAuditLog(config, 'probe', null, { command: 'curl', args: ['--junk-session-cookies', 'https://example.test'] })
    for (const content of [JSON.stringify(records()), readFileSync(config.auditLogPath, 'utf8')]) {
      expect(content).toContain('curl --junk-session-cookies https://example.test')
      expect(content).toContain('"--junk-session-cookies","https://example.test"')
    }
  })

  it('redacts prefixed passphrase options in raw commands and argv', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const command of [
      'curl --proxy-pass synthetic-private-proxy https://example.test',
      'curl --proxy-pass=synthetic-private-proxy https://example.test',
      '"/usr/bin/curl" "--proxy-pass=synthetic-private-proxy" https://example.test',
    ])
      writeAuditLog(config, 'probe', null, { command })
    writeAuditLog(config, 'probe', null, {
      command: 'curl',
      args: ['--proxy-pass', 'synthetic-private-proxy', '--proxy-pass=synthetic-private-proxy'],
      passphrase: 'synthetic-private-proxy',
    })
    expect(JSON.stringify(records())).not.toContain('synthetic-private-proxy')
    expect(readFileSync(config.auditLogPath, 'utf8')).not.toContain('synthetic-private-proxy')
    expect(JSON.stringify(records())).toContain('https://example.test')
  })

  it('redacts credential operands after quoted executable paths', () => {
    const records = captureAudit()
    const config = configFixture()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    for (const executable of ['"/usr/bin/curl"', "'/usr/bin/curl'", '"curl"']) {
      writeAuditLog(config, 'probe', null, {
        command: `${executable} -u name:synthetic-private-quoted https://example.test`,
      })
      writeAuditLog(config, 'probe', null, {
        command: executable,
        args: ['-u', 'name:synthetic-private-quoted', 'https://example.test'],
      })
    }
    writeAuditLog(config, 'probe', null, {
      command: '"/usr/bin/docker" "login" -p synthetic-private-quoted registry.example.test',
    })
    expect(JSON.stringify(records())).not.toContain('synthetic-private-quoted')
    expect(readFileSync(config.auditLogPath, 'utf8')).not.toContain('synthetic-private-quoted')
    expect(records()[0].payload.command).toContain('"/usr/bin/curl"')
    expect(records().at(-1)?.payload.command).toContain('registry.example.test')
  })

  it.each([
    {
      command: 'docker login --password-stdin registry.example.test',
      args: ['login', '--password-stdin', 'registry.example.test'],
      expected: { command: '[OMITTED_SHELL_INPUT]', args: '[OMITTED_SHELL_INPUT]' },
    },
    {
      command: 'mysql --skip-password production_db',
      args: ['--skip-password', 'production_db'],
      expected: { command: 'mysql --skip-password production_db', args: ['--skip-password', 'production_db'] },
    },
  ])('applies stdin privacy and preserves ordinary valueless switches in $command', ({ command, args, expected }) => {
    const records = captureAudit()
    writeAuditLog(configFixture(), 'probe', null, { command, args })
    expect(records()[0].payload).toEqual(expected)
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
