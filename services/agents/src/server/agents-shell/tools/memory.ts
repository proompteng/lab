import {
  listMemoryNotesFromAgentsService,
  persistMemoryNoteToAgentsService,
  retireMemoryNoteInAgentsService,
  retrieveMemoryNotesFromAgentsService,
  type AgentsServiceJsonResult,
  type AgentsRetrieveMemoryNotesInput,
  type AgentsMemoryNoteFilters,
  type AgentsPersistMemoryNoteInput,
  type AgentsPersistMemoryNoteResult,
  type AgentsRetireMemoryNoteInput,
} from '@proompteng/agent-contracts'
import { Effect, Schema } from 'effect'

import { READ_SCOPES, WRITE_SCOPES, readOnlyAnnotations, writeAnnotations } from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { type EffectTool, toolSecurityMeta } from '../mcp-adapter'
import { jsonTextResult } from '../results'

const filters = {
  namespace: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(Schema.String),
  createdAfter: Schema.optional(Schema.String),
  createdBefore: Schema.optional(Schema.String),
  includeRetired: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 50))),
}

const responseBody = <T extends { ok: boolean }>(response: AgentsServiceJsonResult<T>) => {
  if (!response.ok) throw new Error(`Memory API failed (${response.status}): ${response.error ?? 'request failed'}`)
  if (!response.body.ok) throw new Error('Memory API did not return a successful response.')
  return response.body
}

const result = <T extends { ok: boolean }>(response: AgentsServiceJsonResult<T>, maxBytes: number) => {
  const body = responseBody(response)
  if (Buffer.byteLength(JSON.stringify(body)) > maxBytes)
    throw new Error('Memory response exceeds the output limit. Reduce limit or narrow the filters.')
  return jsonTextResult(body)
}

const mutationResult = (response: AgentsServiceJsonResult<AgentsPersistMemoryNoteResult>) => {
  const note = responseBody(response).memory
  if (!note) throw new Error('Memory API returned no mutation receipt.')
  return jsonTextResult({
    ok: true,
    memory: {
      id: note.id,
      createdAt: note.createdAt,
      retiredAt: note.retiredAt,
      replacementId: note.replacementId,
    },
  })
}

export const createMemoryTools = (): EffectTool[] => [
  {
    name: 'memory_search',
    title: 'Search engineering memory',
    auditArguments: false,
    auditResult: false,
    description:
      'Search notes with repository, tag, model and date filters. Excludes retired notes. Verify historical claims against current evidence.',
    inputSchema: Schema.Struct({ ...filters, query: Schema.String.pipe(Schema.minLength(1)) }),
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (input: AgentsRetrieveMemoryNotesInput, { config }) =>
      Effect.tryPromise({
        try: async () =>
          result(
            await retrieveMemoryNotesFromAgentsService({ ...input, limit: input.limit ?? 5 }),
            config.maxOutputBytes,
          ),
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'memory_list',
    title: 'List latest engineering notes',
    auditArguments: false,
    auditResult: false,
    description:
      'List notes newest first with repository, tag, model and date filters. Excludes retired notes. No query embedding.',
    inputSchema: Schema.Struct(filters),
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (input: AgentsMemoryNoteFilters, { config }) =>
      Effect.tryPromise({
        try: async () =>
          result(await listMemoryNotesFromAgentsService({ ...input, limit: input.limit ?? 5 }), config.maxOutputBytes),
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'memory_save',
    title: 'Save engineering memory',
    auditArguments: false,
    auditResult: false,
    description:
      'Save durable knowledge only when explicitly requested. Include repository and commit provenance in metadata. Never save secrets.',
    inputSchema: Schema.Struct({
      namespace: Schema.optional(Schema.String),
      content: Schema.String.pipe(Schema.minLength(1)),
      summary: Schema.optional(Schema.String),
      tags: Schema.optional(Schema.Array(Schema.String)),
      metadata: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    }),
    annotations: writeAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([WRITE_SCOPES[0]]),
    handler: (input: AgentsPersistMemoryNoteInput) =>
      Effect.tryPromise({
        try: async () => mutationResult(await persistMemoryNoteToAgentsService(input)),
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'memory_retire',
    title: 'Retire obsolete engineering memory',
    auditArguments: false,
    auditResult: false,
    description:
      'Retire a verified obsolete note with a reason and optional active replacement. Preserves history. Never retire solely by age.',
    inputSchema: Schema.Struct({
      id: Schema.String,
      reason: Schema.String.pipe(Schema.minLength(1)),
      replacementId: Schema.optional(Schema.String),
    }),
    annotations: { ...writeAnnotations, idempotentHint: true },
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([WRITE_SCOPES[0]]),
    handler: (input: AgentsRetireMemoryNoteInput) =>
      Effect.tryPromise({
        try: async () => mutationResult(await retireMemoryNoteInAgentsService(input)),
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
