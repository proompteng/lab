import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pushCodexEventsToLoki, runCodexSession } from '../codex-runner'

const bunGlobals = vi.hoisted(() => {
  const spawn = vi.fn()
  const file = vi.fn()
  ;(globalThis as unknown as { Bun?: unknown }).Bun = { spawn, file }
  return { spawn, file }
})

const spawnMock = bunGlobals.spawn
const bunFileMock = bunGlobals.file

const encoder = new TextEncoder()

const createWritable = (sink: string[]) =>
  new WritableStream<string>({
    write(chunk) {
      sink.push(chunk)
    },
  })

const createCodexProcess = (messages: string[], promptSink: string[]) => {
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const message of messages) {
        controller.enqueue(encoder.encode(`${message}\n`))
      }
      controller.close()
    },
  })

  return {
    stdin: createWritable(promptSink),
    stdout,
    stderr: null,
    exited: Promise.resolve(0),
  }
}

const createDiscordProcess = (relaySink: string[]) => ({
  stdin: createWritable(relaySink),
  stdout: null,
  stderr: null,
  exited: Promise.resolve(0),
  kill: vi.fn(),
})

describe('codex-runner', () => {
  let workspace: string
  const originalFetch = global.fetch

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'codex-runner-test-'))
    spawnMock.mockReset()
    bunFileMock.mockReset()
    bunFileMock.mockImplementation((path: string) => ({
      text: () => readFile(path, 'utf8'),
    }))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    global.fetch = originalFetch
  })

  it('executes a Codex session and captures agent messages', async () => {
    const promptSink: string[] = []
    const codexMessages = [
      JSON.stringify({ type: 'session.created', session: { id: 'session-123' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello world' } }),
    ]
    spawnMock.mockImplementation(() => createCodexProcess(codexMessages, promptSink))

    const outputPath = join(workspace, 'output.log')
    const jsonOutputPath = join(workspace, 'events.jsonl')
    const agentOutputPath = join(workspace, 'agent.log')
    const result = await runCodexSession({
      stage: 'planning',
      prompt: 'Plan please',
      outputPath,
      jsonOutputPath,
      agentOutputPath,
    })

    expect(result.agentMessages).toEqual(['hello world'])
    expect(result.sessionId).toBe('session-123')
    expect(promptSink).toEqual(['Plan please'])
    expect(await readFile(jsonOutputPath, 'utf8')).toContain('hello world')
    expect(await readFile(agentOutputPath, 'utf8')).toContain('hello world')
  })

  it('passes resume arguments when a session id is provided', async () => {
    const promptSink: string[] = []
    const codexMessages = [
      JSON.stringify({ type: 'session.rehydrated', session: { id: 'resume-42' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'resumed message' } }),
    ]

    spawnMock.mockImplementation(() => createCodexProcess(codexMessages, promptSink))

    const outputPath = join(workspace, 'output.log')
    const jsonOutputPath = join(workspace, 'events.jsonl')
    const agentOutputPath = join(workspace, 'agent.log')

    const result = await runCodexSession({
      stage: 'implementation',
      prompt: 'Continue',
      outputPath,
      jsonOutputPath,
      agentOutputPath,
      resumeSessionId: 'resume-41',
    })

    const spawnArgs = spawnMock.mock.calls[0]?.[0]
    expect(spawnArgs?.cmd).toEqual(
      expect.arrayContaining(['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--json']),
    )
    expect(spawnArgs?.cmd).toContain('resume')
    const resumeIndex = spawnArgs?.cmd?.indexOf('resume')
    expect(resumeIndex).toBeGreaterThan(-1)
    expect(spawnArgs?.cmd?.[resumeIndex + 1]).toBe('resume-41')
    expect(result.sessionId).toBe('resume-42')
  })

  it('streams output to a Discord relay when configured', async () => {
    const relaySink: string[] = []
    const promptSink: string[] = []
    const discordProcess = createDiscordProcess(relaySink)
    const codexProcess = createCodexProcess(
      [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'relay copy' } })],
      promptSink,
    )

    spawnMock.mockImplementationOnce(() => discordProcess).mockImplementationOnce(() => codexProcess)

    const outputPath = join(workspace, 'output.log')
    const jsonOutputPath = join(workspace, 'events.jsonl')
    const agentOutputPath = join(workspace, 'agent.log')

    await runCodexSession({
      stage: 'implementation',
      prompt: 'Implement',
      outputPath,
      jsonOutputPath,
      agentOutputPath,
      discordRelay: {
        command: ['bun', 'run', 'discord-relay.ts'],
      },
    })

    expect(relaySink.some((chunk) => chunk.includes('relay copy'))).toBe(true)
  })

  it('pushes Loki payloads when events exist', async () => {
    const jsonPath = join(workspace, 'events.jsonl')
    await writeFile(
      jsonPath,
      [
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'message' } }),
        JSON.stringify({ type: 'info', detail: 'done' }),
      ].join('\n'),
      'utf8',
    )

    const fetchMock = vi.fn(async () => ({ ok: true }))
    global.fetch = fetchMock as unknown as typeof fetch

    await pushCodexEventsToLoki({
      stage: 'planning',
      endpoint: 'https://loki.example.com/api/v1/push',
      jsonPath,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body
    expect(typeof body).toBe('string')
    const payload = JSON.parse(body as string)
    expect(Array.isArray(payload.streams)).toBe(true)
    expect(payload.streams[0]?.stream).toMatchObject({ stage: 'planning', stream_type: 'json' })
  })

  it('pushes agent and runtime logs and applies tenant headers when provided', async () => {
    const jsonPath = join(workspace, 'events.jsonl')
    const agentPath = join(workspace, 'agent.log')
    const runtimePath = join(workspace, 'runtime.log')

    await writeFile(jsonPath, JSON.stringify({ type: 'info', detail: 'queued' }), 'utf8')
    await writeFile(agentPath, 'Agent says hello\nAnother line', 'utf8')
    await writeFile(runtimePath, 'runtime started\nruntime finished', 'utf8')

    const fetchMock = vi.fn(async () => ({ ok: true }))
    global.fetch = fetchMock as unknown as typeof fetch

    await pushCodexEventsToLoki({
      stage: 'implementation',
      endpoint: 'https://loki.example.com/api/v1/push',
      jsonPath,
      agentLogPath: agentPath,
      runtimeLogPath: runtimePath,
      tenant: 'lab',
      basicAuth: 'token-123',
      labels: {
        repository: 'owner/repo',
        issue: '42',
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, options] = fetchMock.mock.calls[0] ?? []
    const headers = options?.headers as Record<string, string>
    expect(headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Scope-OrgID': 'lab',
      Authorization: 'Basic token-123',
    })

    const bodyRaw = options?.body as string
    const payload = JSON.parse(bodyRaw)
    expect(payload.streams).toHaveLength(3)
    const sources = payload.streams.map((item: { stream: { source: string } }) => item.stream.source).sort()
    expect(sources).toEqual(['codex-agent', 'codex-events', 'codex-runtime'])
    const runtimeStream = payload.streams.find(
      (item: { stream: { stream_type: string } }) => item.stream.stream_type === 'runtime',
    )
    expect(runtimeStream).toBeDefined()
    expect(runtimeStream.stream.repository).toBe('owner/repo')
    expect(runtimeStream.stream.issue).toBe('42')
    expect(runtimeStream.values[0][1]).toBe('runtime started')
  })

  it('throws when Codex exits with a non-zero status', async () => {
    const promptSink: string[] = []
    spawnMock.mockImplementation(() => ({
      stdin: createWritable(promptSink),
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      stderr: null,
      exited: Promise.resolve(2),
    }))

    await expect(
      runCodexSession({
        stage: 'planning',
        prompt: 'fail',
        outputPath: join(workspace, 'output.log'),
        jsonOutputPath: join(workspace, 'events.jsonl'),
        agentOutputPath: join(workspace, 'agent.log'),
      }),
    ).rejects.toThrow('Codex exited with status 2')
  })

  it('invokes the relay error handler when the Discord relay fails to start', async () => {
    const relaySink: string[] = []
    const promptSink: string[] = []
    const discordProcess = {
      stdin: createWritable(relaySink),
      stdout: null,
      stderr: null,
      exited: Promise.resolve(1),
      kill: vi.fn(),
    }
    const codexProcess = createCodexProcess([], promptSink)

    spawnMock.mockImplementationOnce(() => discordProcess).mockImplementationOnce(() => codexProcess)

    const errorSpy = vi.fn()

    await runCodexSession({
      stage: 'planning',
      prompt: 'relay',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
      discordRelay: {
        command: ['bun', 'run', 'relay.ts'],
        onError: errorSpy,
      },
    })

    expect(errorSpy).toHaveBeenCalled()
  })

  it('skips Loki export when the events file is missing', async () => {
    bunFileMock.mockImplementation(() => ({
      text: () => Promise.reject(Object.assign(new Error('not found'), { code: 'ENOENT' })),
    }))

    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    await pushCodexEventsToLoki({
      stage: 'planning',
      endpoint: 'https://loki.example.com/api/v1/push',
      jsonPath: join(workspace, 'missing.jsonl'),
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
