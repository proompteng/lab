#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type JsonObject = Record<string, unknown>

const send = (payload: JsonObject) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

const asRecord = (value: unknown): JsonObject | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const firstTextInput = (params: JsonObject): string => {
  const input = Array.isArray(params.input) ? params.input : []
  for (const item of input) {
    const record = asRecord(item)
    const text = asString(record?.text)
    if (text) return text
  }
  return ''
}

const resolveSmokeArtifactPath = (prompt: string): string | null => {
  const explicit = process.env.AGENTS_FAKE_CODEX_APP_SERVER_ARTIFACT?.trim()
  if (explicit) return explicit
  const match = prompt.match(/`(\/[^`]+(?:result|smoke)[^`]*)`/)
  return match?.[1] ?? null
}

const writeSmokeArtifact = async ({
  path,
  prompt,
  threadId,
  turnId,
  model,
  effort,
}: {
  path: string
  prompt: string
  threadId: string
  turnId: string
  model: unknown
  effort: unknown
}) => {
  await mkdir(dirname(path), { recursive: true })
  const promptSha256 = createHash('sha256').update(prompt).digest('hex')
  await writeFile(
    path,
    [
      'startup status: ok',
      'runner: agents fake Codex app-server',
      `thread: ${threadId}`,
      `turn: ${turnId}`,
      `model: ${String(model ?? '')}`,
      `effort: ${String(effort ?? '')}`,
      `promptSha256: ${promptSha256}`,
      'external side effects: none',
      '',
    ].join('\n'),
    'utf8',
  )
}

const nowMs = () => Date.now()

let nextThread = 1
let nextTurn = 1
const goals = new Map<string, JsonObject>()

const handleRequest = async (request: JsonObject) => {
  const id = request.id
  const method = asString(request.method)
  const params = asRecord(request.params) ?? {}

  if (id === undefined || !method) return

  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          serverInfo: {
            name: 'agents-fake-codex-app-server',
            title: 'Agents fake Codex app-server',
            version: '0.0.0',
          },
        },
      })
      return

    case 'thread/start': {
      const threadId = `thread-fake-${nextThread++}`
      send({
        id,
        result: {
          thread: {
            id: threadId,
            title: 'Agents fake Codex app-server smoke',
            cwd: params.cwd ?? null,
            origin: 'agents-fake-codex-app-server',
          },
        },
      })
      return
    }

    case 'thread/goal/set': {
      const threadId = asString(params.threadId) ?? 'thread-fake-unknown'
      const goal = {
        threadId,
        objective: params.objective ?? null,
        status: params.status ?? 'active',
        tokenBudget: params.tokenBudget ?? null,
      }
      goals.set(threadId, goal)
      send({ id, result: { goal } })
      return
    }

    case 'thread/goal/get': {
      const threadId = asString(params.threadId) ?? 'thread-fake-unknown'
      send({ id, result: { goal: goals.get(threadId) ?? null } })
      return
    }

    case 'thread/goal/clear': {
      const threadId = asString(params.threadId) ?? 'thread-fake-unknown'
      const cleared = goals.delete(threadId)
      send({ id, result: { cleared } })
      return
    }

    case 'turn/start': {
      const threadId = asString(params.threadId) ?? `thread-fake-${nextThread++}`
      const turnId = `turn-fake-${nextTurn++}`
      const startedAt = nowMs()
      const prompt = firstTextInput(params)
      const artifactPath = resolveSmokeArtifactPath(prompt)

      const runningTurn = {
        id: turnId,
        status: 'running',
        items: [],
        error: null,
        startedAt,
        completedAt: null,
        durationMs: 0,
      }
      send({ id, result: { turn: runningTurn } })

      queueMicrotask(async () => {
        send({ method: 'turn/started', params: { threadId, turn: runningTurn } })
        if (artifactPath) {
          try {
            await writeSmokeArtifact({
              path: artifactPath,
              prompt,
              threadId,
              turnId,
              model: params.model,
              effort: params.effort,
            })
          } catch (error) {
            send({
              method: 'error',
              params: {
                threadId,
                turnId,
                message: error instanceof Error ? error.message : String(error),
              },
            })
            return
          }
        }
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId,
            turnId,
            itemId: `${turnId}-message`,
            delta: 'OK\n',
          },
        })
        send({
          method: 'turn/completed',
          params: {
            threadId,
            turn: {
              id: turnId,
              status: 'completed',
              items: [],
              error: null,
              startedAt,
              completedAt: nowMs(),
              durationMs: nowMs() - startedAt,
            },
          },
        })
      })
      return
    }

    case 'turn/interrupt': {
      send({ id, result: {} })
      return
    }

    default:
      send({
        id,
        error: {
          code: -32601,
          message: `unsupported fake app-server method: ${method}`,
        },
      })
  }
}

const main = async () => {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      await handleRequest(JSON.parse(trimmed) as JsonObject)
    } catch (error) {
      send({
        method: 'error',
        params: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
}

await main()
