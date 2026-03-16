import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
})
