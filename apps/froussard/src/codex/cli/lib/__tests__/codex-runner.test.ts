import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pushCodexEventsToLoki, runCodexSession } from '../codex-runner'

const runnerMocks = vi.hoisted(() => ({
  run: vi.fn(),
}))

vi.mock('@proompteng/codex', () => {
  class CodexRunner {
    run = runnerMocks.run
  }
  return { CodexRunner }
})

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

const createWritable = (sink: string[]) => ({
  write(chunk: string) {
    sink.push(chunk)
  },
  flush() {
    return Promise.resolve()
  },
  end() {
    return undefined
  },
})

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
    runnerMocks.run.mockReset()
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    global.fetch = originalFetch
  })

  it('executes a Codex session and captures agent messages', async () => {
    runnerMocks.run.mockImplementation(async (options) => {
      options.onSessionId?.('session-123')
      options.onAgentMessage?.('hello world', { type: 'item.completed' })
      return { agentMessages: ['hello world'], sessionId: 'session-123', exitCode: 0, forcedTermination: false }
    })

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
  })

  it('passes resume arguments when a session id is provided', async () => {
    let capturedResume: string | undefined

    runnerMocks.run.mockImplementation(async (options) => {
      capturedResume = options.resumeSessionId as string | undefined
      return { agentMessages: [], sessionId: 'resume-42', exitCode: 0, forcedTermination: false }
    })

    await runCodexSession({
      stage: 'implementation',
      prompt: 'Continue',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
      resumeSessionId: 'resume-41',
    })

    expect(capturedResume).toBe('resume-41')
  })

  it('maps --last resume into the runner option', async () => {
    let capturedResume: string | undefined

    runnerMocks.run.mockImplementation(async (options) => {
      capturedResume = options.resumeSessionId as string | undefined
      return { agentMessages: [], sessionId: 'resume-99', exitCode: 0, forcedTermination: false }
    })

    await runCodexSession({
      stage: 'implementation',
      prompt: 'Continue',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
      resumeSessionId: '--last',
    })

    expect(capturedResume).toBe('last')
  })

  it('streams agent messages and tool calls to a Discord channel when configured', async () => {
    const channelSink: string[] = []
    const discordProcess = createDiscordProcess(channelSink)
    spawnMock.mockImplementationOnce(() => discordProcess)

    runnerMocks.run.mockImplementation(async (options) => {
      options.onToolCall?.('shell {"command":["bash","-lc","echo hello"]}', 'tool-line')
      options.onAgentMessage?.('channel copy', { type: 'item.completed' })
      return { agentMessages: ['channel copy'], sessionId: 'session-1', exitCode: 0, forcedTermination: false }
    })

    await runCodexSession({
      stage: 'implementation',
      prompt: 'Implement',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
      discordChannel: {
        command: ['bun', 'run', 'discord-channel.ts'],
      },
    })

    expect(channelSink.some((chunk) => chunk.includes('channel copy'))).toBe(true)
    expect(channelSink.some((chunk) => chunk.includes('ToolCall → shell'))).toBe(true)
  })

  it('prioritizes delta streaming when provided', async () => {
    const channelSink: string[] = []
    const discordProcess = createDiscordProcess(channelSink)
    spawnMock.mockImplementationOnce(() => discordProcess)

    runnerMocks.run.mockImplementation(async (options) => {
      options.onAgentMessageDelta?.('delta chunk', { type: 'response.output_text.delta' })
      options.onAgentMessage?.('final message', { type: 'item.completed' })
      return { agentMessages: ['final message'], sessionId: 'session-1', exitCode: 0, forcedTermination: false }
    })

    await runCodexSession({
      stage: 'implementation',
      prompt: 'Implement',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
      discordChannel: {
        command: ['bun', 'run', 'discord-channel.ts'],
      },
    })

    expect(channelSink.some((chunk) => chunk.includes('delta chunk'))).toBe(true)
    expect(channelSink.some((chunk) => chunk.includes('final message'))).toBe(false)
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
})
