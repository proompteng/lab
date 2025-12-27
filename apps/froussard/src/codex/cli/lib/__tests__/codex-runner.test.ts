import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runnerMocks = {
  run: vi.fn(),
}

const spawnMock = vi.fn<(options: { cmd?: string[] }) => BunProcess>()
const bunFileMock = vi.fn<(path: string) => { text: () => Promise<string> }>()
let bunGlobal: Record<string, unknown> | undefined
let originalSpawn: unknown
let originalFile: unknown
let hadBun = false

let runCodexSession: typeof import('../codex-runner').runCodexSession
let pushCodexEventsToLoki: typeof import('../codex-runner').pushCodexEventsToLoki

type BunProcess = {
  stdin?: unknown
  stdout?: unknown
  stderr?: unknown
  exited: Promise<number>
  kill?: () => void
}

const installBunMocks = () => {
  const globalRef = globalThis as { Bun?: Record<string, unknown> }
  bunGlobal = globalRef.Bun
  hadBun = Boolean(bunGlobal)
  if (!bunGlobal) {
    bunGlobal = {}
    globalRef.Bun = bunGlobal
  }
  originalSpawn = bunGlobal.spawn
  originalFile = bunGlobal.file
  bunGlobal.spawn = spawnMock
  bunGlobal.file = bunFileMock
}

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

    installBunMocks()

    vi.resetModules()
    vi.doMock('@proompteng/codex', () => {
      class CodexRunner {
        run = runnerMocks.run
      }
      return { CodexRunner }
    })

    const module = await import('../codex-runner')
    runCodexSession = module.runCodexSession
    pushCodexEventsToLoki = module.pushCodexEventsToLoki
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    global.fetch = originalFetch
    if (bunGlobal) {
      if (originalSpawn !== undefined) {
        bunGlobal.spawn = originalSpawn
      } else {
        delete bunGlobal.spawn
      }
      if (originalFile !== undefined) {
        bunGlobal.file = originalFile
      } else {
        delete bunGlobal.file
      }
      if (!hadBun) {
        delete (globalThis as { Bun?: Record<string, unknown> }).Bun
      }
    }
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

  it('streams command output and token usage to stdout and Discord', async () => {
    const channelSink: string[] = []
    const stdoutSink: string[] = []
    const discordProcess = createDiscordProcess(channelSink)
    spawnMock.mockImplementationOnce(() => discordProcess)

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutSink.push(String(chunk))
      return true
    })

    runnerMocks.run.mockImplementation(async (options) => {
      options.onEvent?.({
        type: 'item.started',
        item: { type: 'command_execution', command: '/bin/bash -lc ls' },
      })
      options.onEvent?.({
        type: 'item.completed',
        item: { type: 'command_execution', command: '/bin/bash -lc ls', aggregated_output: 'lab', exit_code: 0 },
      })
      options.onEvent?.({
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_tokens: 3 },
      })
      return { agentMessages: [], sessionId: 'session-2', exitCode: 0, forcedTermination: false }
    })

    await runCodexSession({
      stage: 'implementation',
      prompt: 'List workspace',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
      discordChannel: {
        command: ['bun', 'run', 'discord-channel.ts'],
      },
    })

    stdoutSpy.mockRestore()

    const stdoutText = stdoutSink.join('')
    expect(stdoutText).toContain('$ /bin/bash -lc ls')
    expect(stdoutText).toContain('lab')
    expect(stdoutText).toContain('Usage → input: 10 (cached 2) | output: 5 | reasoning: 3')

    const channelText = channelSink.join('')
    expect(channelText).toContain('\n```ts\n')
    expect(channelText).toContain('$ /bin/bash -lc ls')
    expect(channelText).toContain('lab')
    expect(channelText).toContain('\n```\n')
    expect(channelText).toContain('Usage → input: 10 (cached 2) | output: 5 | reasoning: 3')
  })

  it('truncates long command output in Discord code blocks', async () => {
    const channelSink: string[] = []
    const discordProcess = createDiscordProcess(channelSink)
    spawnMock.mockImplementationOnce(() => discordProcess)

    const outputLines = Array.from({ length: 12 }, (_, index) => `line${index + 1}`)
    const outputText = `${outputLines.join('\n')}\n`

    runnerMocks.run.mockImplementation(async (options) => {
      options.onEvent?.({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'echo lines', aggregated_output: outputText, exit_code: 0 },
      })
      return { agentMessages: [], sessionId: 'session-3', exitCode: 0, forcedTermination: false }
    })

    await runCodexSession({
      stage: 'implementation',
      prompt: 'Print lines',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
      discordChannel: {
        command: ['bun', 'run', 'discord-channel.ts'],
      },
    })

    const channelText = channelSink.join('')
    expect(channelText).toContain('\n```ts\n')
    expect(channelText).toContain('$ echo lines')
    expect(channelText).toContain('line1')
    expect(channelText).toContain('line9')
    expect(channelText).toContain('... (truncated, 3 more lines)')
    expect(channelText).toContain('\n```\n')
    expect(channelText).not.toContain('line10')
    expect(channelText).not.toContain('line11')
    expect(channelText).not.toContain('line12')
  })

  it('streams reasoning summaries to stdout and Discord', async () => {
    const channelSink: string[] = []
    const stdoutSink: string[] = []
    const discordProcess = createDiscordProcess(channelSink)
    spawnMock.mockImplementationOnce(() => discordProcess)

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutSink.push(String(chunk))
      return true
    })

    runnerMocks.run.mockImplementation(async (options) => {
      options.onEvent?.({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'Investigating repo layout.' },
      })
      return { agentMessages: [], sessionId: 'session-4', exitCode: 0, forcedTermination: false }
    })

    await runCodexSession({
      stage: 'implementation',
      prompt: 'Explain',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
      discordChannel: {
        command: ['bun', 'run', 'discord-channel.ts'],
      },
    })

    stdoutSpy.mockRestore()

    const stdoutText = stdoutSink.join('')
    expect(stdoutText).toContain('Investigating repo layout.')

    const channelText = channelSink.join('')
    expect(channelText).toContain('Investigating repo layout.')
  })

  it('streams thread and item events to stdout and Discord', async () => {
    const channelSink: string[] = []
    const stdoutSink: string[] = []
    const discordProcess = createDiscordProcess(channelSink)
    spawnMock.mockImplementationOnce(() => discordProcess)

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutSink.push(String(chunk))
      return true
    })

    runnerMocks.run.mockImplementation(async (options) => {
      options.onEvent?.({ type: 'turn.started' })
      options.onEvent?.({ type: 'turn.failed', error: { message: 'model request failed: rate_limit_exceeded' } })
      options.onEvent?.({ type: 'error', message: 'stream error: stream disconnected before completion' })
      options.onEvent?.({
        type: 'item.completed',
        item: {
          type: 'file_change',
          changes: [
            { path: 'README.md', kind: 'update' },
            { path: 'old.txt', kind: 'delete' },
          ],
          status: 'completed',
        },
      })
      options.onEvent?.({
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          server: 'github',
          tool: 'search_issues',
          arguments: { query: 'is:open label:bug' },
          status: 'in_progress',
        },
      })
      options.onEvent?.({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          server: 'github',
          tool: 'search_issues',
          arguments: { query: 'is:open label:bug' },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'Found 12 issues' }] },
        },
      })
      options.onEvent?.({
        type: 'item.completed',
        item: {
          type: 'mcp_tool_call',
          server: 'github',
          tool: 'search_issues',
          arguments: { query: 'is:open label:bug' },
          status: 'failed',
          error: { message: 'unauthorized' },
        },
      })
      options.onEvent?.({
        type: 'item.completed',
        item: { type: 'web_search', query: 'codex exec jsonl event types' },
      })
      options.onEvent?.({
        type: 'item.started',
        item: {
          type: 'todo_list',
          items: [
            { text: 'Inspect repo', completed: false },
            { text: 'Summarize findings', completed: false },
          ],
        },
      })
      options.onEvent?.({
        type: 'item.updated',
        item: {
          type: 'todo_list',
          items: [
            { text: 'Inspect repo', completed: true },
            { text: 'Summarize findings', completed: false },
          ],
        },
      })
      options.onEvent?.({
        type: 'item.completed',
        item: {
          type: 'todo_list',
          items: [
            { text: 'Inspect repo', completed: true },
            { text: 'Summarize findings', completed: true },
          ],
        },
      })
      options.onEvent?.({
        type: 'item.completed',
        item: { type: 'error', message: 'non-fatal error: command declined' },
      })
      return { agentMessages: [], sessionId: 'session-5', exitCode: 0, forcedTermination: false }
    })

    await runCodexSession({
      stage: 'implementation',
      prompt: 'Handle events',
      outputPath: join(workspace, 'output.log'),
      jsonOutputPath: join(workspace, 'events.jsonl'),
      agentOutputPath: join(workspace, 'agent.log'),
      discordChannel: {
        command: ['bun', 'run', 'discord-channel.ts'],
      },
    })

    stdoutSpy.mockRestore()

    const stdoutText = stdoutSink.join('')
    expect(stdoutText).toContain('Turn started')
    expect(stdoutText).toContain('Turn failed → model request failed: rate_limit_exceeded')
    expect(stdoutText).toContain('Stream error → stream error: stream disconnected before completion')
    expect(stdoutText).toContain('Files changed (completed) → update README.md, delete old.txt')
    expect(stdoutText).toContain('MCP → github.search_issues (in_progress) query="is:open label:bug"')
    expect(stdoutText).toContain('Found 12 issues')
    expect(stdoutText).toContain('Error → unauthorized')
    expect(stdoutText).toContain('Web search → codex exec jsonl event types')
    expect(stdoutText).toContain('Todo list (started):')
    expect(stdoutText).toContain('- [ ] Inspect repo')
    expect(stdoutText).toContain('Todo list (updated):')
    expect(stdoutText).toContain('- [x] Inspect repo')
    expect(stdoutText).toContain('Todo list (completed):')
    expect(stdoutText).toContain('- [x] Summarize findings')
    expect(stdoutText).toContain('Error item → non-fatal error: command declined')

    const channelText = channelSink.join('')
    expect(channelText).toContain('Turn started')
    expect(channelText).toContain('Turn failed → model request failed: rate_limit_exceeded')
    expect(channelText).toContain('Stream error → stream error: stream disconnected before completion')
    expect(channelText).toContain('Files changed (completed) → update README.md, delete old.txt')
    expect(channelText).toContain('MCP → github.search_issues (in_progress) query="is:open label:bug"')
    expect(channelText).toContain('Found 12 issues')
    expect(channelText).toContain('Error → unauthorized')
    expect(channelText).toContain('Web search → codex exec jsonl event types')
    expect(channelText).toContain('Todo list (started):')
    expect(channelText).toContain('- [ ] Inspect repo')
    expect(channelText).toContain('Todo list (updated):')
    expect(channelText).toContain('- [x] Inspect repo')
    expect(channelText).toContain('Todo list (completed):')
    expect(channelText).toContain('- [x] Summarize findings')
    expect(channelText).toContain('Error item → non-fatal error: command declined')
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
