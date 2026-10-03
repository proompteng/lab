import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { auditStdout, flushAuditLog, sanitizeAuditPayload, writeAuditLog } from './agents-shell/audit'
import { formatCommand } from './agents-shell/process-runner'
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
  const server = createAgentsShellServer(runner.config, runner, auth, 'request-fixture')
  const client = new Client({ name: 'audit-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  connections.push({ client, server, runner })
  return { client, runner, config: runner.config }
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
    const payload = {
      command: 'git show abc123 -- src/token-count.ts',
      arguments: { args: ['show', 'abc123'], cwd: '/workspace/repo-a' },
      result: {
        content: 'const tokenCount = 400;\n',
        stdout: '雪😀 complete output',
        stderr: 'precise ordinary failure',
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

  it('masks credential values only, including argv pairs and errors, without changing original responses', () => {
    vi.stubEnv('SYNTHETIC_API_TOKEN', 'synthetic-runtime-credential')
    const result = sanitizeAuditPayload({
      arguments: {
        args: ['--password', 'synthetic-password', '--token', '=', 'synthetic-token', '--token-count', '300'],
      },
      result: {
        token: 'synthetic-token',
        error: 'Authorization: Bearer synthetic-header\nordinary error',
        stdout: 'before synthetic-runtime-credential after',
        tokenCount: 300,
      },
    })
    expect(JSON.stringify(result)).not.toContain('synthetic-password')
    expect(JSON.stringify(result)).not.toContain('synthetic-token')
    expect(JSON.stringify(result)).not.toContain('synthetic-header')
    expect(JSON.stringify(result)).not.toContain('synthetic-runtime-credential')
    expect(result.payload).toMatchObject({
      arguments: {
        args: ['--password', '[REDACTED_CREDENTIAL]', '--token', '=', '[REDACTED_CREDENTIAL]', '--token-count', '300'],
      },
      result: { tokenCount: 300, stdout: 'before [REDACTED_CREDENTIAL] after' },
    })
  })

  it('masks the explicit structured credential table while preserving references', () => {
    const names = [
      'accessToken',
      'refresh_token',
      'idToken',
      'api-key',
      'clientSecret',
      'privateKey',
      'PGPASSWORD',
      'HTTP_AUTHORIZATION',
      'PROXY_AUTHORIZATION',
      'secretAccessKey',
      'secret_access_key',
      'AGENTS_ARTIFACTS_SECRET_ACCESS_KEY',
      'MINIO_SECRET_KEY',
      'secretKey',
      'sessionToken',
      'authToken',
      'reconnectToken',
      'githubToken',
      'dbPassword',
      'adminPassword',
    ]
    const original = Object.fromEntries(names.map((key) => [key, 'synthetic-table-credential']))
    const refs = {
      tokenCount: 3,
      token_budget: 20,
      pageToken: 'ordinary-page',
      cancellationToken: 'ordinary-cancel',
      tokenType: 'ordinary-type',
      privateKeyPath: '/ordinary/key',
      secretKeyRef: { name: 'secret', key: 'auth.json' },
      secretName: 'config',
      secretRef: { name: 'config', key: 'ordinary' },
      accessKeyId: 'ordinary-id',
      TOKEN_PATH: '/ordinary/token',
      SECRET_KEY_NAME: 'auth.json',
    }
    expect(sanitizeAuditPayload({ ...original, ...refs }).payload).toEqual({
      ...Object.fromEntries(names.map((key) => [key, '[REDACTED_CREDENTIAL]'])),
      ...refs,
    })
    expect(original.secretAccessKey).toBe('synthetic-table-credential')
  })

  it('masks explicit credential argv pairs while leaving noncredential options visible', () => {
    for (const option of [
      'auth-token',
      'session-token',
      'secret-access-key',
      'secret-key',
      'reconnect-token',
      'access-token',
      'refresh-token',
      'id-token',
      'private-key',
      'github-token',
      'db-password',
      'admin-password',
    ]) {
      expect(
        sanitizeAuditPayload({ args: [`--${option}`, 'synthetic-table-credential', '--token-count', '300'] }).payload,
      ).toEqual({ args: [`--${option}`, '[REDACTED_CREDENTIAL]', '--token-count', '300'] })
    }
  })

  it('uses trusted kubectl tool context for Secret literal argv without masking arbitrary args data', () => {
    const payload = {
      arguments: { args: ['create', 'secret', 'generic', 'demo', '--from-literal=registry=opaque-runtime-secret'] },
    }
    expect(sanitizeAuditPayload(payload, false, 'kubectl_admin').payload).toEqual({
      arguments: { args: ['create', 'secret', 'generic', 'demo', '--from-literal=registry=[REDACTED_CREDENTIAL]'] },
    })
    expect(sanitizeAuditPayload(payload, false, 'read_file').payload).toEqual(payload)
    expect(payload.arguments.args[4]).toBe('--from-literal=registry=opaque-runtime-secret')
  })

  it('keeps Secret context collection inside admitted fields and array indices', () => {
    const { records } = captureAudit()
    const hidden = { command: 'kubectl create secret generic demo --from-literal=registry=abc' }
    Object.defineProperty(hidden, 'cycle', { value: hidden, enumerable: true })
    const touched = vi.fn(() => {
      throw new Error('excluded metadata/array property inspected')
    })
    const excluded = new Proxy(hidden, { ownKeys: touched })
    const items = ['ordinary']
    Object.defineProperty(items, 'unadmitted', { value: excluded, enumerable: true })
    Object.defineProperty(items, 'command', { get: touched, enumerable: true })
    writeAuditLog(configFixture(), 'probe', authFixture(), { _meta: excluded, items })
    expect(records()[0]).toMatchObject({ payloadTruncated: false, payload: { items: ['ordinary'] } })
    expect(JSON.stringify(records()[0].payload)).not.toContain('unadmitted')
    expect(touched).not.toHaveBeenCalled()
  })

  it('masks literal command duplicates and actual echo values while retaining ordinary source', () => {
    const command =
      "KUBECONFIG=/tmp/config kubectl create secret generic demo --from-literal=registry='opaque-runtime-secret'"
    const original = {
      command,
      args: ['create', 'secret', 'generic', 'demo', '--from-literal=registry=opaque-runtime-secret'],
      result: {
        command,
        stdout: 'ordinary opaque-runtime-secret output',
        stderr: Buffer.from('opaque-runtime-secret').toString('base64'),
      },
      content: "echo 'kubectl create configmap demo --from-literal=registry=ordinary'",
    }
    const sanitized = sanitizeAuditPayload(original).payload
    expect(JSON.stringify(sanitized)).not.toContain('opaque-runtime-secret')
    expect(JSON.stringify(sanitized)).not.toContain(Buffer.from('opaque-runtime-secret').toString('base64'))
    expect(sanitized).toMatchObject({
      command: command.replace('opaque-runtime-secret', '[REDACTED_CREDENTIAL]'),
      args: ['create', 'secret', 'generic', 'demo', '--from-literal=registry=[REDACTED_CREDENTIAL]'],
      result: { stdout: 'ordinary [REDACTED_CREDENTIAL] output' },
      content: original.content,
    })
    expect(original.result.stdout).toBe('ordinary opaque-runtime-secret output')
  })

  it('does not dispatch array map overrides during sanitized export', () => {
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

  it('masks explicit credential-name/value and plural scalar containers while keeping references', () => {
    const payload = {
      env: [
        { name: 'PGPASSWORD', value: 'synthetic-env-credential' },
        { name: 'GITHUB_TOKEN', valueFrom: { secretKeyRef: { name: 'config', key: 'token' } } },
        { name: 'CODEX_AUTH', value: '/ordinary/auth.json' },
        { name: 'TOKEN_PATH', value: '/ordinary/token' },
      ],
      OPENAI_API_KEYS: ['synthetic-first', 'synthetic-second'],
      _auth: 'synthetic-npm',
      'client-key-data': 'synthetic-private-key',
    }
    expect(sanitizeAuditPayload(payload).payload).toEqual({
      env: [
        { name: 'PGPASSWORD', value: '[REDACTED_CREDENTIAL]' },
        { name: 'GITHUB_TOKEN', valueFrom: { secretKeyRef: { name: 'config', key: 'token' } } },
        { name: 'CODEX_AUTH', value: '/ordinary/auth.json' },
        { name: 'TOKEN_PATH', value: '/ordinary/token' },
      ],
      OPENAI_API_KEYS: ['[REDACTED_CREDENTIAL]', '[REDACTED_CREDENTIAL]'],
      _auth: '[REDACTED_CREDENTIAL]',
      'client-key-data': '[REDACTED_CREDENTIAL]',
    })
  })

  it('rejects oversized events before masking or serialization with a bounded explicit receipt', () => {
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
    const { client, runner } = await connect()
    const expected = new Map<string, { stdout: string; stderr: string }>()
    const jobs = await Promise.all(
      ['agent-a', 'agent-b'].map(async (agentId) => {
        const stdout = `${agentId}:雪😀\n`.repeat(30_000)
        const stderr = `${agentId}:diagnostic\n`.repeat(20_000)
        const command = `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(`${agentId}:雪😀\n`)}.repeat(30000)); process.stderr.write(${JSON.stringify(`${agentId}:diagnostic\n`)}.repeat(20000))`)}`
        const result = await client.callTool({
          name: 'shell_start',
          arguments: { command, agentId, maxOutputBytes: 1024 },
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
    const listed = await client.callTool({ name: 'shell_status', arguments: {} })
    expect((data(listed).jobs as any[]).map((job) => job.agentId).sort()).toEqual(['agent-a', 'agent-b'])
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
      let text = ''
      do {
        const read = await client.callTool({
          name: 'shell_read',
          arguments: {
            jobId,
            stdoutOffset: offset,
            stderrOffset: expected.get(jobId)!.stderr.length,
            maxOutputBytes: 20_000,
          },
        })
        text += data(read).stdout
        offset = Number(data(read).stdoutNextOffset)
      } while (offset < Buffer.byteLength(expected.get(jobId)!.stdout))
      expect(text).toBe(expected.get(jobId)!.stdout)
    }
  })

  it('prevents another owner from reading, listing or stopping jobs', async () => {
    captureAudit()
    const { client, runner } = await connect()
    const second = await connect(runner, authFixture('owner-b'))
    const start = await client.callTool({ name: 'shell_start', arguments: { command: 'sleep 3', agentId: 'owner-b' } })
    const jobId = data(start).jobId
    expect(data(await second.client.callTool({ name: 'shell_status', arguments: {} })).jobs).toEqual([])
    for (const name of ['shell_read', 'shell_kill', 'shell_status'])
      expect((await second.client.callTool({ name, arguments: { jobId } })).isError).toBe(true)
    expect(runner.requireJob(String(jobId), authFixture()).status).toBe('running')
    await client.callTool({ name: 'shell_kill', arguments: { jobId } })
    await vi.waitFor(() => expect(runner.requireJob(String(jobId), authFixture()).finishedAt).not.toBeNull())
    expect(runner.requireJob(String(jobId), authFixture()).status).toBe('killed')
  })

  it('mirrors CLI tools and retains credential-safe argv with exact failure details', async () => {
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
    expect(JSON.stringify(records())).not.toContain('synthetic-cli-password')
    expect(
      records()
        .filter((event) => event.event === 'process_output')
        .map((event) => event.payload.text)
        .join(''),
    ).toContain('exact command failure')
  })

  it.each([
    ['--from-literal=registry=opaque-runtime-secret'],
    ['--from-literal', 'registry=left;right|tail&last'],
    ['--from-literal=registry=single\'quote"double\\slash\nlast'],
  ])('masks Secret literal argv, command duplicates and both process streams for %s', async (...literalArgs) => {
    const { records } = captureAudit()
    const { client, config } = await connect()
    const executable = join(config.workspaceRoot, 'kubectl')
    writeFileSync(
      executable,
      '#!/bin/sh\nnext=0\nfor arg do\n if [ "$next" = 1 ]; then value=${arg#registry=}; next=0; fi\n case "$arg" in --from-literal) next=1;; --from-literal=registry=*) value=${arg#--from-literal=registry=};; esac\ndone\nprintf "%s\\n" "$value"; printf "%s\\n" "$value" >&2; printf "%s" "$value" | base64; printf "ordinary command output\\n"\n',
      { mode: 0o755 },
    )
    vi.stubEnv('PATH', `${config.workspaceRoot}:${process.env.PATH}`)
    const args = ['create', 'secret', 'generic', 'demo', ...literalArgs]
    const credential = literalArgs.at(-1)?.replace(/^(?:--from-literal=)?registry=/, '') ?? ''
    const response = await client.callTool({ name: 'kubectl_admin', arguments: { args } })
    expect(response.isError).not.toBe(true)
    expect(response.structuredContent).toMatchObject({
      stdout: expect.stringContaining(credential),
      stderr: `${credential}\n`,
    })
    const encoded = JSON.stringify(records())
    expect(encoded).not.toContain(JSON.stringify(credential).slice(1, -1))
    expect(encoded).not.toContain(Buffer.from(credential).toString('base64'))
    for (const stream of ['stdout', 'stderr']) {
      const output = records()
        .filter((record) => record.event === 'process_output' && record.payload.stream === stream)
        .map((record) => record.payload.text)
        .join('')
      expect(output).toContain('[REDACTED_CREDENTIAL]')
      expect(output).not.toContain(credential)
    }
    expect(records().some((record) => record.event === 'tool_call_started')).toBe(true)
    expect(records().some((record) => record.event === 'tool_call_finished')).toBe(true)
    expect(args.at(-1)).toBe(literalArgs.at(-1))
  })

  it.each(['abc', 'x'.repeat(4097)])(
    'omits unsafe Secret literal capture without failing original execution',
    async (credential) => {
      const { records } = captureAudit()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { client, config } = await connect()
      writeFileSync(
        join(config.workspaceRoot, 'kubectl'),
        '#!/bin/sh\nfor arg do case "$arg" in --from-literal=registry=*) printf "%s\\n" "${arg#--from-literal=registry=}";; esac; done\n',
        { mode: 0o755 },
      )
      vi.stubEnv('PATH', `${config.workspaceRoot}:${process.env.PATH}`)
      const response = await client.callTool({
        name: 'kubectl_admin',
        arguments: { args: ['create', 'secret', 'generic', 'demo', `--from-literal=registry=${credential}`] },
      })
      expect(response.isError).not.toBe(true)
      expect(response.structuredContent).toMatchObject({ exitCode: 0, stdout: `${credential}\n` })
      expect(records().filter((record) => record.event === 'process_output')).toHaveLength(0)
      expect(records().filter((record) => record.event === 'process_output_finished')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ payload: expect.objectContaining({ captureIncomplete: true }) }),
        ]),
      )
      expect(
        records()
          .filter((record) => record.event !== 'process_output_finished')
          .every((record) => record.payload.captureIncomplete === true),
      ).toBe(true)
    },
  )

  it('masks actual Secret literal shell echo arguments in started and duplicate result commands', async () => {
    const { records } = captureAudit()
    const { client, config } = await connect()
    const executable = join(config.workspaceRoot, 'kubectl')
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const command = `KUBECONFIG=/dev/null ${formatCommand(executable, ['create', 'secret', 'generic', 'demo', '--from-literal=registry=opaque-runtime-secret'])}; printf '%s\\n' opaque-runtime-secret; printf '%s\\n' opaque-runtime-secret >&2`
    const response = await client.callTool({ name: 'shell_run', arguments: { command } })
    expect(response.structuredContent).toMatchObject({
      exitCode: 0,
      stdout: 'opaque-runtime-secret\n',
      stderr: 'opaque-runtime-secret\n',
      command,
    })
    expect(JSON.stringify(records())).not.toContain('opaque-runtime-secret')
    expect(records().some((record) => record.event === 'tool_call_finished')).toBe(true)
  })

  it('masks HTTP cookie credentials in process events while retaining the authorized output', async () => {
    const { records } = captureAudit()
    const { client } = await connect()
    const result = await client.callTool({
      name: 'shell_run',
      arguments: {
        command:
          "printf '%s\\n' 'Cookie: sid=synthetic-cookie-value' 'Set-Cookie: session=synthetic-session-value; HttpOnly' 'ordinary HTTP diagnostic'",
      },
    })
    expect(data(result).stdout).toContain('sid=synthetic-cookie-value')
    expect(JSON.stringify(records())).not.toContain('synthetic-cookie-value')
    expect(JSON.stringify(records())).not.toContain('synthetic-session-value')
    expect(
      records()
        .filter((record) => record.event === 'process_output')
        .map((record) => record.payload.text)
        .join(''),
    ).toBe('Cookie: [REDACTED_CREDENTIAL]\nSet-Cookie: [REDACTED_CREDENTIAL]\nordinary HTTP diagnostic\n')
  })

  it('masks Secret stdout, redirected stderr and partial shell_read duplicates while preserving original tool output', async () => {
    const { records } = captureAudit()
    const { client, config } = await connect()
    const secret = '{"data":{"arbitrary":"c3ludGhldGljLWNyZWRlbnRpYWw="},"metadata":{"name":"fixture"},"kind":"Secret"}'
    const binary = join(config.workspaceRoot, 'kubectl')
    writeFileSync(binary, `#!/bin/sh\nprintf '%s' '${secret}'\n`, { mode: 0o755 })
    vi.stubEnv('PATH', `${config.workspaceRoot}:${process.env.PATH}`)
    const cli = await client.callTool({
      name: 'kubectl',
      arguments: { args: ['get', 'secret', 'fixture', '-o', 'json'] },
    })
    expect(data(cli).stdout).toBe(secret)
    const shell = await client.callTool({
      name: 'shell_run',
      arguments: { command: `${binary} get secret fixture -o json >&2` },
    })
    expect(data(shell).stderr).toBe(secret)
    await client.callTool({
      name: 'shell_read',
      arguments: { jobId: data(shell).jobId, stderrOffset: 20, maxOutputBytes: 1024 },
    })
    expect(JSON.stringify(records())).not.toContain('c3ludGhldGljLWNyZWRlbnRpYWw=')
    for (const stream of ['stdout', 'stderr']) {
      expect(
        records().some(
          (record) =>
            record.event === 'process_output' &&
            record.payload.stream === stream &&
            record.payload.text.includes('[REDACTED_CREDENTIAL]'),
        ),
      ).toBe(true)
    }
    expect(records().some((record) => record.captureIncomplete === true)).toBe(true)
  })

  it.each([
    { format: 'metadata', attached: false },
    { format: 'metadata', attached: true },
    { format: 'json', attached: false },
    { format: 'yaml', attached: true },
  ])(
    'masks Docker registry credentials and structured blobs for $format attached=$attached',
    async ({ format, attached }) => {
      const { records } = captureAudit()
      const { client, config } = await connect()
      const password = 'opaque-runtime-secret'
      const encoded = Buffer.from(
        JSON.stringify({
          auths: { registry: { username: 'user', password, auth: Buffer.from(`user:${password}`).toString('base64') } },
        }),
      ).toString('base64')
      const document =
        format === 'yaml'
          ? `apiVersion: v1\nkind: Secret\nmetadata:\n  name: regcred\ndata:\n  .dockerconfigjson: ${encoded}\n`
          : JSON.stringify({
              apiVersion: 'v1',
              kind: 'Secret',
              metadata: { name: 'regcred' },
              data: { '.dockerconfigjson': encoded },
            })
      const stdout = format === 'metadata' ? 'secret/regcred created\n' : document
      const stderr = format === 'metadata' ? `${password}\n` : document
      const executable = join(config.workspaceRoot, 'kubectl')
      writeFileSync(
        executable,
        `#!/bin/sh\n${formatCommand('printf', ['%s', stdout])}\n${formatCommand('printf', ['%s', stderr])} >&2\n`,
        { mode: 0o755 },
      )
      vi.stubEnv('PATH', config.workspaceRoot)
      vi.stubEnv('KUBECONFIG', '/dev/null')
      const args = [
        '--kubeconfig',
        '/dev/null',
        'create',
        'secret',
        'docker-registry',
        'regcred',
        '--docker-username=user',
        ...(attached ? [`--docker-password=${password}`] : ['--docker-password', password]),
        ...(format === 'metadata' ? [] : [`-o${format}`]),
      ]
      const response = await client.callTool({ name: 'kubectl_admin', arguments: { args } })
      expect(response.isError).not.toBe(true)
      expect(response.structuredContent).toMatchObject({ exitCode: 0, stdout, stderr })
      expect(JSON.stringify(records())).not.toContain(password)
      expect(JSON.stringify(records())).not.toContain(encoded)
      for (const stream of ['stdout', 'stderr']) {
        const output = records()
          .filter((record) => record.event === 'process_output' && record.payload.stream === stream)
          .map((record) => record.payload.text)
          .join('')
        if (stream === 'stdout' && format === 'metadata') expect(output).toBe(stdout)
        else expect(output).toContain('[REDACTED_CREDENTIAL]')
      }
      expect(args).toContain(attached ? `--docker-password=${password}` : password)
    },
  )

  it('omits qualified Secret projections and preserves their original authorized output', async () => {
    const { records } = captureAudit()
    const { client, config } = await connect()
    const executable = join(config.workspaceRoot, 'kubectl')
    writeFileSync(executable, '#!/bin/sh\nprintf "%s" "opaque-projected-secret"\n', { mode: 0o755 })
    const command = `KUBECONFIG=/dev/null ${formatCommand(executable, ['get', 'secrets.v1./demo', '-o', 'jsonpath={.data.registry}'])}`
    const response = await client.callTool({ name: 'shell_run', arguments: { command } })
    expect(response.structuredContent).toMatchObject({ exitCode: 0, stdout: 'opaque-projected-secret' })
    expect(JSON.stringify(records())).not.toContain('opaque-projected-secret')
    expect(records().filter((record) => record.event === 'process_output')).toHaveLength(0)
    expect(
      records().some(
        (record) => record.event === 'process_output_finished' && record.payload.captureIncomplete === true,
      ),
    ).toBe(true)
  })

  it('can inspect its growing local log without recursively amplifying it', async () => {
    const { records } = captureAudit()
    const { client, config } = await connect()
    config.auditLogPath = join(config.workspaceRoot, 'audit.jsonl')
    const response = await client.callTool({
      name: 'shell_run',
      arguments: { command: `timeout 1 tail -n +1 -f ${config.auditLogPath}`, maxOutputBytes: 20_000 },
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
    const response = await client.callTool({ name: 'shell_read', arguments: { jobId: 'missing-job' } })
    expect(response.isError).toBe(true)
    expect(JSON.stringify(records())).toContain('unknown or expired jobId: missing-job')
    const auth = authFixture('unauthenticated')
    auth.scopes.clear()
    const denied = await connect(undefined, auth)
    await denied.client.callTool({ name: 'shell_run', arguments: { command: 'sensitive-denied-input' } })
    expect(JSON.stringify(records())).not.toContain('sensitive-denied-input')
  })
})
