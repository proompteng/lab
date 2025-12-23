import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pushCodexEventsToLoki, runCodexSession } from '../codex-runner'

type BunProcess = {
  stdin?: unknown
  stdout?: unknown
  stderr?: unknown
  exited: Promise<number>
  kill?: () => void
}

const bunGlobals = vi.hoisted(() => {
  const spawn = vi.fn<(options: { cmd?: string[] }) => BunProcess>()
  const file = vi.fn<(path: string) => { text: () => Promise<string> }>()
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

const createCodexProcessWithStdin = (messages: string[], stdin: unknown) => {
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const message of messages) {
        controller.enqueue(encoder.encode(`${message}\n`))
      }
      controller.close()
    },
  })

  return {
    stdin,
    stdout,
    stderr: null,
    exited: Promise.resolve(0),
  }
}

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

const createDiscordProcess = (channelSink: string[]) => ({
  stdin: createWritable(channelSink),
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
      stage: 'implementation',
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
    if (resumeIndex === undefined || resumeIndex < 0) {
      throw new Error('resume argument missing')
    }
    expect(spawnArgs?.cmd?.[resumeIndex + 1]).toBe('resume-41')
    expect(result.sessionId).toBe('resume-42')
  })

  it('uses --last resume without dash and still sends prompt on stdin', async () => {
    const promptSink: string[] = []
    const codexMessages = [
      JSON.stringify({ type: 'session.rehydrated', session: { id: 'resume-99' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'resumed message' } }),
    ]

    spawnMock.mockImplementation(() => createCodexProcess(codexMessages, promptSink))

    const outputPath = join(workspace, 'output.log')
    const jsonOutputPath = join(workspace, 'events.jsonl')
    const agentOutputPath = join(workspace, 'agent.log')

    await runCodexSession({
      stage: 'implementation',
      prompt: 'should-not-be-sent',
      outputPath,
      jsonOutputPath,
      agentOutputPath,
      resumeSessionId: '--last',
    })

    const spawnArgs = spawnMock.mock.calls[0]?.[0]
    expect(spawnArgs?.cmd).toContain('resume')
    expect(spawnArgs?.cmd).toContain('--last')
    expect(spawnArgs?.cmd).not.toContain('-')
    expect(promptSink).toEqual(['should-not-be-sent'])
  })

  it('captures session ids from SessionConfiguredEvent log lines', async () => {
    const promptSink: string[] = []
    const sessionLog = [
      '2025-11-01T19:29:14.313728Z  INFO codex_exec: Codex initialized with event: SessionConfiguredEvent { ',
      'session_id: ConversationId { uuid: 019a40e5-341a-7501-ad84-5ccdb240e7ff }, model: "gpt-5.2-codex", ',
      'reasoning_effort: Some(High), history_log_id: 0, history_entry_count: 0, initial_messages: None, ',
      'rollout_path: "/root/.codex/sessions/2025/11/01/rollout-2025-11-01T19-29-14-019a40e5-341a-7501-ad84-5ccdb240e7ff.jsonl" }',
    ].join('')
    const codexMessages = [
      sessionLog,
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
    ]
    spawnMock.mockImplementation(() => createCodexProcess(codexMessages, promptSink))

    const outputPath = join(workspace, 'output.log')
    const jsonOutputPath = join(workspace, 'events.jsonl')
    const agentOutputPath = join(workspace, 'agent.log')

    const result = await runCodexSession({
      stage: 'implementation',
      prompt: 'Plan',
      outputPath,
      jsonOutputPath,
      agentOutputPath,
    })

    expect(result.sessionId).toBe('019a40e5-341a-7501-ad84-5ccdb240e7ff')
  })

  it('passes model override from CODEX_MODEL env to codex exec', async () => {
    const promptSink: string[] = []
    const codexMessages = [
      JSON.stringify({ type: 'session.created', session: { id: 'session-abc' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    ]
    spawnMock.mockImplementation(() => createCodexProcess(codexMessages, promptSink))

    const originalModel = process.env.CODEX_MODEL
    process.env.CODEX_MODEL = 'gpt-5.2-codex'

    const outputPath = join(workspace, 'output.log')
    const jsonOutputPath = join(workspace, 'events.jsonl')
    const agentOutputPath = join(workspace, 'agent.log')

    await runCodexSession({
      stage: 'implementation',
      prompt: 'Plan please',
      outputPath,
      jsonOutputPath,
      agentOutputPath,
    })

    const spawnArgs = spawnMock.mock.calls[0]?.[0]
    expect(spawnArgs?.cmd).toContain('-m')
    const modelIndex = spawnArgs?.cmd?.indexOf('-m')
    if (modelIndex === undefined || modelIndex < 0) {
      throw new Error('model flag missing')
    }
    expect(spawnArgs?.cmd?.[modelIndex + 1]).toBe('gpt-5.2-codex')

    process.env.CODEX_MODEL = originalModel
  })

  it('writes prompts to Bun FileSink-backed stdin without throwing', async () => {
    const promptSink: string[] = []
    const fileSinkStdin = {
      write(this: { sink: string[] }, chunk: string) {
        this.sink.push(chunk)
      },
      flush(this: { sink: string[] }) {
        return Promise.resolve(this.sink.length)
      },
      end(this: { sink: string[] }) {
        this.sink.push('<end>')
      },
      sink: promptSink,
    }
    const codexMessages = [
      JSON.stringify({ type: 'session.created', session: { id: 'session-filesink' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    ]

    spawnMock.mockImplementation(() => createCodexProcessWithStdin(codexMessages, fileSinkStdin))

    await runCodexSession({
      stage: 'implementation',
      prompt: 'FileSink prompt',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
    })

    expect(promptSink).toEqual(['FileSink prompt', '<end>'])
  })

  it('streams agent messages and tool calls to a Discord channel when configured', async () => {
    const channelSink: string[] = []
    const promptSink: string[] = []
    const discordProcess = createDiscordProcess(channelSink)
    const toolCallLine =
      '2025-11-01T19:29:20.903182Z  INFO codex_core::codex: ToolCall: shell {"command":["bash","-lc","echo hello"]}'
    const codexProcess = createCodexProcess(
      [toolCallLine, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'channel copy' } })],
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
      discordChannel: {
        command: ['bun', 'run', 'discord-channel.ts'],
      },
    })

    expect(channelSink.some((chunk) => chunk.includes('channel copy'))).toBe(true)
    expect(channelSink.some((chunk) => chunk.includes('ToolCall → shell {"command"'))).toBe(true)
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

    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<{ ok: boolean }>>(async () => ({
      ok: true,
    }))
    global.fetch = fetchMock as unknown as typeof fetch

    await pushCodexEventsToLoki({
      stage: 'implementation',
      endpoint: 'https://loki.example.com/api/v1/push',
      jsonPath,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body
    expect(typeof body).toBe('string')
    const payload = JSON.parse(body as string)
    expect(Array.isArray(payload.streams)).toBe(true)
    expect(payload.streams[0]?.stream).toMatchObject({ stage: 'implementation', stream_type: 'json' })
  })

  it('pushes agent and runtime logs and applies tenant headers when provided', async () => {
    const jsonPath = join(workspace, 'events.jsonl')
    const agentPath = join(workspace, 'agent.log')
    const runtimePath = join(workspace, 'runtime.log')

    await writeFile(jsonPath, JSON.stringify({ type: 'info', detail: 'queued' }), 'utf8')
    await writeFile(agentPath, 'Agent says hello\nAnother line', 'utf8')
    await writeFile(runtimePath, 'runtime started\nruntime finished', 'utf8')

    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<{ ok: boolean }>>(async () => ({
      ok: true,
    }))
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
        stage: 'implementation',
        prompt: 'fail',
        outputPath: join(workspace, 'output.log'),
        jsonOutputPath: join(workspace, 'events.jsonl'),
        agentOutputPath: join(workspace, 'agent.log'),
      }),
    ).rejects.toThrow('Codex exited with status 2')
  })

  it('allows artifact capture when Codex exits non-zero but events log is empty', async () => {
    const promptSink: string[] = []

    spawnMock.mockImplementation(() => ({
      stdin: createWritable(promptSink),
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      stderr: null,
      exited: Promise.resolve(1),
    }))

    const outputPath = join(workspace, 'output.log')
    const jsonOutputPath = join(workspace, 'events.jsonl')
    const agentOutputPath = join(workspace, 'agent.log')

    await expect(
      runCodexSession({
        stage: 'implementation',
        prompt: 'empty-events',
        outputPath,
        jsonOutputPath,
        agentOutputPath,
      }),
    ).resolves.not.toThrow()

    const eventsContent = await readFile(jsonOutputPath, 'utf8')
    expect(eventsContent.trim()).toBe('')
  })

  it('invokes the channel error handler when the Discord channel fails to start', async () => {
    const channelSink: string[] = []
    const promptSink: string[] = []
    const discordProcess = {
      stdin: createWritable(channelSink),
      stdout: null,
      stderr: null,
      exited: Promise.resolve(1),
      kill: vi.fn(),
    }
    const codexProcess = createCodexProcess([], promptSink)

    spawnMock.mockImplementationOnce(() => discordProcess).mockImplementationOnce(() => codexProcess)

    const errorSpy = vi.fn()

    await runCodexSession({
      stage: 'implementation',
      prompt: 'channel',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
      discordChannel: {
        command: ['bun', 'run', 'channel.ts'],
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
      stage: 'implementation',
      endpoint: 'https://loki.example.com/api/v1/push',
      jsonPath: join(workspace, 'missing.jsonl'),
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('kills the Codex process after idle timeout', async () => {
    const promptSink: string[] = []

    const hangingReader = {
      read: vi.fn(() => new Promise<never>(() => {})),
      cancel: vi.fn(async () => {}),
    }

    const codexProcess = {
      stdin: createWritable(promptSink),
      stdout: { getReader: () => hangingReader },
      stderr: null,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    }

    spawnMock.mockImplementation(() => codexProcess)

    const outputPath = join(workspace, 'output.log')
    const jsonOutputPath = join(workspace, 'events.jsonl')
    const agentOutputPath = join(workspace, 'agent.log')

    const originalEnv = { ...process.env }
    process.env.CODEX_IDLE_TIMEOUT_MS = '5'

    const sessionPromise = runCodexSession({
      stage: 'implementation',
      prompt: 'hang',
      outputPath,
      jsonOutputPath,
      agentOutputPath,
    })

    await sessionPromise

    expect(codexProcess.kill).toHaveBeenCalled()
    expect(hangingReader.cancel).toHaveBeenCalled()
    process.env = originalEnv
  })

  it('uses the shorter grace timeout after turn.completed', async () => {
    const promptSink: string[] = []

    const readMock = vi
      .fn()
      .mockResolvedValueOnce({
        value: encoder.encode(`${JSON.stringify({ type: 'turn.completed' })}\n`),
        done: false,
      })
      .mockImplementation(() => new Promise<never>(() => {}))

    const hangingReader = {
      read: readMock,
      cancel: vi.fn(async () => {}),
    }

    const codexProcess = {
      stdin: createWritable(promptSink),
      stdout: { getReader: () => hangingReader },
      stderr: null,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    }

    spawnMock.mockImplementation(() => codexProcess)

    const outputPath = join(workspace, 'output.log')
    const jsonOutputPath = join(workspace, 'events.jsonl')
    const agentOutputPath = join(workspace, 'agent.log')

    const originalEnv = { ...process.env }
    process.env.CODEX_IDLE_TIMEOUT_MS = '1000'
    process.env.CODEX_EXIT_GRACE_MS = '20'

    const sessionPromise = runCodexSession({
      stage: 'review',
      prompt: 'turn-complete',
      outputPath,
      jsonOutputPath,
      agentOutputPath,
    })

    await sessionPromise

    expect(codexProcess.kill).toHaveBeenCalled()
    expect(hangingReader.cancel).toHaveBeenCalled()
    process.env = originalEnv
  })

  it('does not throw when forced idle termination exits non-zero', async () => {
    const promptSink: string[] = []

    const hangingReader = {
      read: vi.fn(() => new Promise<never>(() => {})),
      cancel: vi.fn(async () => {}),
    }

    const codexProcess = {
      stdin: createWritable(promptSink),
      stdout: { getReader: () => hangingReader },
      stderr: null,
      exited: Promise.resolve(143),
      kill: vi.fn(),
    }

    spawnMock.mockImplementation(() => codexProcess)

    const outputPath = join(workspace, 'output.log')
    const jsonOutputPath = join(workspace, 'events.jsonl')
    const agentOutputPath = join(workspace, 'agent.log')

    const originalEnv = { ...process.env }
    process.env.CODEX_IDLE_TIMEOUT_MS = '5'

    await expect(
      runCodexSession({
        stage: 'implementation',
        prompt: 'hang-and-kill',
        outputPath,
        jsonOutputPath,
        agentOutputPath,
      }),
    ).resolves.not.toThrow()

    expect(codexProcess.kill).toHaveBeenCalled()
    process.env = originalEnv
  })
})
