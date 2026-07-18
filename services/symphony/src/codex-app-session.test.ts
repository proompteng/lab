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
            readTimeoutMs: 5_000,
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

  test('advertises required initialize capabilities when dynamic tools are enabled', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'symphony-codex-capabilities-'))
    const scriptPath = path.join(tempDir, 'fake-codex-app-server.mjs')
    const seenEvents: string[] = []

    await writeFile(
      scriptPath,
      `
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
let experimentalApi = false
let requestAttestation
let pendingThreadStartId

rl.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'initialize') {
    experimentalApi = Boolean(message.params?.capabilities?.experimentalApi)
    requestAttestation = message.params?.capabilities?.requestAttestation
    console.log(JSON.stringify({ id: message.id, result: {} }))
    return
  }

  if (message.method === 'thread/start') {
    if (requestAttestation !== false) {
      console.log(JSON.stringify({
        id: message.id,
        error: { code: -32600, message: 'initialize.capabilities.requestAttestation must be false' },
      }))
      return
    }
    if (!experimentalApi) {
      console.log(JSON.stringify({
        id: message.id,
        error: { code: -32600, message: 'thread/start.dynamicTools requires experimentalApi capability' },
      }))
      return
    }

    pendingThreadStartId = message.id
    console.log(JSON.stringify({
      id: 900,
      method: 'currentTime/read',
      params: { threadId: 'thread-1' },
    }))
    return
  }

  if (message.id === 900) {
    if (!Number.isInteger(message.result?.currentTimeAt) || message.result.currentTimeAt <= 0) {
      console.log(JSON.stringify({
        id: pendingThreadStartId,
        error: { code: -32600, message: 'currentTime/read returned an invalid timestamp' },
      }))
      return
    }
    console.log(JSON.stringify({ id: pendingThreadStartId, result: { thread: { id: 'thread-1' } } }))
    return
  }

  if (message.method === 'turn/start') {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1' } } }))
    console.log(JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    }))
  }
})
      `.trim(),
      'utf8',
    )

    const dynamicTool: DynamicToolSpec = {
      type: 'function',
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
                seenEvents.push(event.event)
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
      expect(seenEvents).toContain('turn_started')
      expect(seenEvents).toContain('turn_completed')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('emits current turn sandbox policy shapes for legacy sandbox modes', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'symphony-codex-sandbox-policy-'))
    const scriptPath = path.join(tempDir, 'fake-codex-app-server.mjs')

    await writeFile(
      scriptPath,
      `
import readline from 'node:readline'

const expectedByMode = {
  'workspace-write': {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  'read-only': {
    type: 'readOnly',
    networkAccess: true,
  },
}
const expected = expectedByMode[process.env.SYMPHONY_SANDBOX_CASE]
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
    const actual = message.params?.sandboxPolicy
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      console.log(JSON.stringify({
        id: message.id,
        error: { code: -32602, message: 'unexpected sandbox policy: ' + JSON.stringify(actual) },
      }))
      return
    }

    console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1' } } }))
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
      for (const threadSandbox of ['workspace-write', 'read-only'] as const) {
        const program = Effect.scoped(
          Effect.gen(function* () {
            const sessions = yield* CodexSessionService
            const session = yield* sessions.createSession({
              command: `SYMPHONY_SANDBOX_CASE=${threadSandbox} node ${JSON.stringify(scriptPath)}`,
              cwd: tempDir,
              approvalPolicy: null,
              threadSandbox,
              turnSandboxPolicy: null,
              readTimeoutMs: 5_000,
              turnTimeoutMs: 5_000,
              title: 'sandbox policy turn',
              dynamicTools: [],
              logger: createStubLogger(),
              onEvent: () => Effect.void,
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
      }
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
