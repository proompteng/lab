import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { DynamicToolSpec } from '@proompteng/codex'
import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'

import { CodexProtocolError } from './errors'
import { CodexSessionService, decodeProtocolMessage, makeCodexSessionLayer } from './codex-app-session'
import type { Logger } from './logger'

const createStubLogger = (): Logger => ({
  log: () => {},
  child: () => createStubLogger(),
})

describe('codex protocol decoding', () => {
  test('decodes JSON-RPC protocol lines', () => {
    const decoded = decodeProtocolMessage('{"id":1,"method":"initialize","params":{}}')
    expect(decoded).toEqual({ id: 1, method: 'initialize', params: {} })
  })

  test('rejects non-object JSON payloads', () => {
    expect(() => decodeProtocolMessage('"text"')).toThrow(CodexProtocolError)
  })

  test('tears down a hung codex process when the session scope closes', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'symphony-codex-session-'))
    const scriptPath = path.join(tempDir, 'fake-codex-app-server.mjs')

    await writeFile(
      scriptPath,
      `
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'initialize') {
    console.log(JSON.stringify({ id: message.id, result: {} }))
    return
  }

  if (message.method === 'thread/start') {
    console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-1' } } }))
    return
  }

  if (message.method === 'turn/start') {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1' } } }))
  }
})

setInterval(() => {}, 1000)
      `.trim(),
      'utf8',
    )

    let childPid: number | null = null

    try {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* CodexSessionService
          const session = yield* sessions.createSession({
            command: `node ${JSON.stringify(scriptPath)}`,
            cwd: tempDir,
            approvalPolicy: null,
            threadSandbox: null,
            turnSandboxPolicy: null,
            readTimeoutMs: 1_000,
            turnTimeoutMs: 50,
            title: 'test turn',
            dynamicTools: [],
            logger: createStubLogger(),
            onEvent: (event) =>
              Effect.sync(() => {
                if (event.codexAppServerPid) {
                  childPid = Number(event.codexAppServerPid)
                }
              }),
            onToolCall: () =>
              Effect.succeed({
                success: false,
                error: 'unsupported_tool_call',
                contentItems: [],
              }),
          })

          yield* session.runTurn('hang forever').pipe(
            Effect.flatMap(() => Effect.fail(new Error('expected turn timeout'))),
            Effect.catchAll((error) =>
              error instanceof CodexProtocolError && error.code === 'turn_timeout' ? Effect.void : Effect.fail(error),
            ),
          )
        }),
      ).pipe(
        Effect.provide(makeCodexSessionLayer(createStubLogger())),
        Effect.timeoutFail({
          duration: 2_000,
          onTimeout: () => new Error('scoped codex session did not shut down'),
        }),
      )

      await Effect.runPromise(program)

      expect(childPid).not.toBeNull()

      let exited = false
      const deadline = Date.now() + 2_000

      while (childPid !== null && Date.now() < deadline) {
        try {
          process.kill(childPid, 0)
          await Bun.sleep(25)
        } catch (error) {
          const candidate = error as NodeJS.ErrnoException
          if (candidate.code === 'ESRCH') {
            exited = true
            break
          }
          throw error
        }
      }

      expect(exited).toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('advertises experimentalApi when dynamic tools are enabled', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'symphony-codex-capabilities-'))
    const scriptPath = path.join(tempDir, 'fake-codex-app-server.mjs')
    const seenEvents: Array<{
      event: string
      prompt?: string | null
      outputChoices?: Array<Record<string, unknown>> | null
    }> = []

    await writeFile(
      scriptPath,
      `
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
let experimentalApi = false

rl.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'initialize') {
    experimentalApi = Boolean(message.params?.capabilities?.experimentalApi)
    console.log(JSON.stringify({ id: message.id, result: {} }))
    return
  }

  if (message.method === 'thread/start') {
    if (!experimentalApi) {
      console.log(JSON.stringify({
        id: message.id,
        error: { code: -32600, message: 'thread/start.dynamicTools requires experimentalApi capability' },
      }))
      return
    }

    console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-1' } } }))
    return
  }

  if (message.method === 'turn/start') {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1' } } }))
    console.log(JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        outputChoices: [{ role: 'assistant', content: 'done' }],
        provider: 'codex',
        model: 'gpt-5.4',
        latency: 1.5,
      },
    }))
  }
})
      `.trim(),
      'utf8',
    )

    const dynamicTool: DynamicToolSpec = {
      name: 'linear_graphql',
      description: 'Test dynamic tool',
      inputSchema: {
        type: 'object',
      },
    }

    try {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* CodexSessionService
          const session = yield* sessions.createSession({
            command: `node ${JSON.stringify(scriptPath)}`,
            cwd: tempDir,
            approvalPolicy: null,
            threadSandbox: null,
            turnSandboxPolicy: null,
            readTimeoutMs: 5_000,
            turnTimeoutMs: 5_000,
            title: 'dynamic tool turn',
            dynamicTools: [dynamicTool],
            logger: createStubLogger(),
            onEvent: (event) =>
              Effect.sync(() => {
                seenEvents.push({
                  event: event.event,
                  prompt: event.prompt,
                  outputChoices: event.outputChoices ?? null,
                })
              }),
            onToolCall: () =>
              Effect.succeed({
                success: false,
                error: 'unsupported_tool_call',
                contentItems: [],
              }),
          })

          return yield* session.runTurn('hello')
        }),
      ).pipe(Effect.provide(makeCodexSessionLayer(createStubLogger())))

      const result = await Effect.runPromise(program)
      expect(result).toEqual({
        status: 'completed',
        threadId: 'thread-1',
        turnId: 'turn-1',
      })
      expect(seenEvents).toContainEqual({
        event: 'turn_started',
        prompt: 'hello',
        outputChoices: null,
      })
      expect(seenEvents).toContainEqual({
        event: 'turn_completed',
        prompt: undefined,
        outputChoices: [{ role: 'assistant', content: 'done' }],
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('fails the turn when the app-server emits a top-level error notification', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'symphony-codex-error-notification-'))
    const scriptPath = path.join(tempDir, 'fake-codex-app-server.mjs')
    const seenEvents: string[] = []

    await writeFile(
      scriptPath,
      `
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'initialize') {
    console.log(JSON.stringify({ id: message.id, result: {} }))
    return
  }

  if (message.method === 'thread/start') {
    console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'thread-1' } } }))
    return
  }

  if (message.method === 'turn/start') {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1' } } }))
    console.log(JSON.stringify({
      method: 'error',
      params: {
        error: {
          message: 'Quota exceeded. Check your plan and billing details.',
          codexErrorInfo: 'usageLimitExceeded',
        },
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    }))
    console.log(JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    }))
  }
})
      `.trim(),
      'utf8',
    )

    try {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* CodexSessionService
          const session = yield* sessions.createSession({
            command: `node ${JSON.stringify(scriptPath)}`,
            cwd: tempDir,
            approvalPolicy: null,
            threadSandbox: null,
            turnSandboxPolicy: null,
            readTimeoutMs: 5_000,
            turnTimeoutMs: 5_000,
            title: 'error notification turn',
            dynamicTools: [],
            logger: createStubLogger(),
            onEvent: (event) =>
              Effect.sync(() => {
                seenEvents.push(`${event.event}:${event.message ?? ''}`)
              }),
            onToolCall: () =>
              Effect.succeed({
                success: false,
                error: 'unsupported_tool_call',
                contentItems: [],
              }),
          })

          return yield* session.runTurn('hello')
        }),
      ).pipe(Effect.provide(makeCodexSessionLayer(createStubLogger())))

      const exit = await Effect.runPromiseExit(program)
      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure') {
        const failure = JSON.parse(JSON.stringify(exit)).cause?.failure ?? null
        expect(failure).toMatchObject({
          code: 'turn_failed',
          causeValue: {
            error: {
              message: 'Quota exceeded. Check your plan and billing details.',
            },
          },
        })
      }
      expect(seenEvents).toContain('turn_ended_with_error:Quota exceeded. Check your plan and billing details.')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
