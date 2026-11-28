import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'

import { BodyTooLargeError, readBoundedText } from './body'

export class AutoOntologyUpstreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const invalidResponse = () =>
  new AutoOntologyUpstreamError('upstream_invalid_response', 'Auto Ontology returned an incompatible response')

const object = z.record(z.string(), z.unknown())
const healthPayload = z.object({ status: z.string() })
const statusPayload = z.object({ calculated: z.boolean() })
const catalogPayload = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().nullish() })),
})
const chatPayload = z.object({
  response: z.string(),
  sql_code: z.string().nullish(),
  sql_response_from_db: z.unknown().optional(),
})

const decodeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw invalidResponse()
  }
}

const decodeAnswer = (text: string) => {
  // NVIDIA 1.3.0 emits heartbeats and step events before its terminal result.
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    if (data === '[DONE]') break
    const event = object.parse(decodeJson(data))
    if (event.type === 'error') {
      throw new AutoOntologyUpstreamError('upstream_chat_error', 'Auto Ontology could not answer the question')
    }
    if (event.type !== 'result') continue

    const answer = chatPayload.parse(event.answer)
    let rows = answer.sql_response_from_db
    if (Array.isArray(rows) && rows.length === 1 && typeof rows[0] === 'string') rows = decodeJson(rows[0])
    const records = z.array(object).parse(rows == null ? [] : Array.isArray(rows) ? rows : [rows])
    return {
      answer: answer.response,
      sql: answer.sql_code ?? '',
      rows: records.slice(0, 100),
      row_count: records.length,
      truncated: records.length > 100,
    }
  }
  throw new AutoOntologyUpstreamError('upstream_chat_incomplete', 'Auto Ontology ended the stream without an answer')
}

type Query = Record<string, string | number | undefined>
type Question = { question: string; max_distance?: number }
type ChatQuestion = { question: string; evidence?: string }
type UpstreamOptions = {
  url: URL
  token: string
  maxResponseBytes: number
  timeoutMs: number
  chatTimeoutMs: number
  fetch?: FetchLike
}

export const createAutoOntologyUpstream = (options: UpstreamOptions) => {
  const fetchImpl = options.fetch ?? fetch
  const json = (text: string) => {
    const value = decodeJson(text)
    return Array.isArray(value) ? { data: value } : object.parse(value)
  }

  const request = async <T>(
    path: `/api/${string}`,
    decode: (text: string) => T,
    requestOptions: {
      signal?: AbortSignal
      query?: Query
      body?: Question | ChatQuestion
      accept?: 'application/json' | 'text/event-stream'
      timeoutMs?: number
      authenticated?: boolean
    },
  ) => {
    const url = new URL(options.url)
    url.pathname = path
    for (const [key, value] of Object.entries(requestOptions.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const deadline = AbortSignal.timeout(requestOptions.timeoutMs ?? options.timeoutMs)
    const signal = requestOptions.signal ? AbortSignal.any([deadline, requestOptions.signal]) : deadline
    const accept = requestOptions.accept ?? 'application/json'
    const headers = new Headers({ accept })
    if (requestOptions.authenticated !== false) headers.set('x-api-key', options.token)
    const body = requestOptions.body && JSON.stringify(requestOptions.body)
    if (body) headers.set('content-type', 'application/json')

    try {
      const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers, body, signal, redirect: 'error' })
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        throw new AutoOntologyUpstreamError('upstream_http_error', `Auto Ontology returned HTTP ${response.status}`)
      }
      if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== accept) {
        void response.body?.cancel().catch(() => undefined)
        throw invalidResponse()
      }
      return decode(await readBoundedText(response, options.maxResponseBytes, signal))
    } catch (error) {
      if (deadline.aborted) throw new AutoOntologyUpstreamError('upstream_timeout', 'Auto Ontology request timed out')
      if (error instanceof AutoOntologyUpstreamError) throw error
      if (error instanceof BodyTooLargeError) {
        throw new AutoOntologyUpstreamError(
          'upstream_response_too_large',
          'Auto Ontology response exceeded the size limit',
        )
      }
      if (error instanceof z.ZodError) throw invalidResponse()
      throw new AutoOntologyUpstreamError('upstream_unavailable', 'Could not reach Auto Ontology')
    }
  }

  return {
    get: (path: `/api/${string}`, signal: AbortSignal, query?: Query) => request(path, json, { signal, query }),
    checkHealth: async (signal?: AbortSignal) => {
      const health = await request('/api/health', (text) => healthPayload.parse(decodeJson(text)), {
        signal,
        authenticated: false,
      })
      if (health.status !== 'ok') {
        throw new AutoOntologyUpstreamError('upstream_unhealthy', 'Auto Ontology reported unhealthy status')
      }
      return health
    },
    checkReadiness: async (signal?: AbortSignal) => {
      // Run authenticated checks sequentially so one tool call does not contend on Better Auth's single apikey row lock.
      const status = await request(
        '/api/semantic-compilation/status',
        (text) => statusPayload.parse(decodeJson(text)),
        {
          signal,
        },
      )
      const catalog = await request('/api/datasources/dbs', (text) => catalogPayload.parse(decodeJson(text)), {
        signal,
      })
      return {
        ready: status.calculated && catalog.data.length > 0,
        semantic_layer_built: status.calculated,
        catalog_present: catalog.data.length > 0,
        databases: catalog.data.map(({ id, name }) => name || id),
      }
    },
    checkAnswerable: ({ question, max_distance }: Question, signal: AbortSignal) =>
      request('/api/question-entity-coverage', json, {
        signal,
        body: { question, max_distance },
        timeoutMs: options.chatTimeoutMs,
      }),
    askQuestion: ({ question, evidence }: ChatQuestion, signal: AbortSignal) =>
      // A conversation_id makes the API persist the turn. Never accept or send one.
      request('/api/chat/completions', decodeAnswer, {
        signal,
        body: { question, evidence },
        accept: 'text/event-stream',
        timeoutMs: options.chatTimeoutMs,
      }),
  }
}

export type AutoOntologyUpstream = ReturnType<typeof createAutoOntologyUpstream>
