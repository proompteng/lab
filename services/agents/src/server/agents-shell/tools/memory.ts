import {
  listMemoryNotesFromAgentsService,
  getMemoryNoteFromAgentsService,
  fitMemoryNotesPage,
  readMemoryNote,
  persistMemoryNoteToAgentsService,
  retireMemoryNoteInAgentsService,
  retrieveRepoContextFromAgentsService,
  fitRepoContext,
  type AgentsServiceJsonResult,
  type RepoContextInput,
  type AgentsListMemoryNotesInput,
  type AgentsPersistMemoryNoteInput,
  type AgentsPersistMemoryNoteResult,
  type AgentsRetireMemoryNoteInput,
} from '@proompteng/agent-contracts'
import { Effect, Schema } from 'effect'

import {
  READ_SCOPES,
  WRITE_SCOPES,
  REPLY_META_RESERVE_BYTES,
  readOnlyAnnotations,
  writeAnnotations,
} from '../constants'
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
  cursor: Schema.optional(
    Schema.String.annotations({ description: 'nextCursor from the previous page. Keep the same filters.' }),
  ),
}

type SaveInput = Omit<AgentsPersistMemoryNoteInput, 'metadata'> & { repository?: string; commit: string }

const responseBody = <T extends { ok: boolean }>(response: AgentsServiceJsonResult<T>) => {
  if (!response.ok) throw new Error(`Memory API failed (${response.status}): ${response.error ?? 'request failed'}`)
  if (!response.body.ok) throw new Error('Memory API did not return a successful response.')
  return response.body
}

const replyBytes = (value: Record<string, unknown>) =>
  Buffer.byteLength(JSON.stringify(jsonTextResult(value))) + REPLY_META_RESERVE_BYTES

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
    name: 'retrieve_context',
    title: 'Retrieve repository context',
    auditArguments: false,
    auditResult: false,
    description:
      'Search code and notes together. Supply expectedCommit for freshness. Open note IDs with memory_get. Reports unavailable sources.',
    inputSchema: Schema.Struct({
      query: Schema.String.pipe(Schema.minLength(1)),
      repository: Schema.optional(Schema.String),
      expectedCommit: Schema.optional(Schema.String),
      pathPrefix: Schema.optional(Schema.String),
      tags: Schema.optional(Schema.Array(Schema.String)),
      limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 10))),
    }),
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (input: RepoContextInput, { config }) =>
      Effect.tryPromise({
        try: async () => {
          const body = responseBody(
            await retrieveRepoContextFromAgentsService({
              ...input,
              maxBytes: Math.min(config.defaultOutputBytes, 64_000),
            }),
          )
          return jsonTextResult(
            fitRepoContext(
              body,
              config.defaultOutputBytes,
              (value) => Buffer.byteLength(JSON.stringify(jsonTextResult(value))) + REPLY_META_RESERVE_BYTES,
            ),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'memory_get',
    title: 'Read an engineering note',
    auditArguments: false,
    auditResult: false,
    description:
      'Read a note by ID, including retired history. Follow nextOffset for the remaining content. No embedding request.',
    inputSchema: Schema.Struct({
      id: Schema.String.annotations({ description: 'Note ID returned by retrieve_context or memory_list.' }),
      offset: Schema.optional(
        Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)).annotations({
          description: 'nextOffset from the previous response. Omit for the first chunk.',
        }),
      ),
    }),
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (input: { id: string; offset?: number }, { config }) =>
      Effect.tryPromise({
        try: async () => {
          const note = responseBody(await getMemoryNoteFromAgentsService(input.id)).memory
          if (!note) throw new Error('Memory API returned no note.')
          return jsonTextResult(readMemoryNote(note, input.offset, config.defaultOutputBytes, replyBytes))
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'memory_list',
    title: 'List latest engineering notes',
    auditArguments: false,
    auditResult: false,
    description:
      'Browse compact note summaries newest first. Follow nextCursor with the same filters. Use memory_get to read a note.',
    inputSchema: Schema.Struct(filters),
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (input: AgentsListMemoryNotesInput, { config }) =>
      Effect.tryPromise({
        try: async () =>
          jsonTextResult(
            fitMemoryNotesPage(
              responseBody(await listMemoryNotesFromAgentsService({ ...input, limit: input.limit ?? 5 })),
              config.defaultOutputBytes,
              replyBytes,
            ),
          ),
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'memory_save',
    title: 'Save engineering memory',
    auditArguments: false,
    auditResult: false,
    description:
      'Save requested durable knowledge with repository and commit provenance. Identical saves reuse their note ID. Never save secrets.',
    inputSchema: Schema.Struct({
      namespace: Schema.optional(Schema.String),
      content: Schema.String.pipe(Schema.minLength(1)),
      summary: Schema.optional(Schema.String),
      tags: Schema.optional(Schema.Array(Schema.String)),
      repository: Schema.optional(
        Schema.String.pipe(Schema.pattern(/^[\w.-]+\/[\w.-]+$/), Schema.maxLength(200)).annotations({
          description: 'Repository owner/name. Defaults to proompteng/lab.',
        }),
      ),
      commit: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/i)).annotations({
        description: 'Full source commit SHA from the checkout. Never invent a commit.',
      }),
    }),
    annotations: { ...writeAnnotations, idempotentHint: true },
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([WRITE_SCOPES[0]]),
    handler: (input: SaveInput) =>
      Effect.tryPromise({
        try: async () => {
          const { repository = 'proompteng/lab', commit, ...note } = input
          return mutationResult(
            await persistMemoryNoteToAgentsService({ ...note, metadata: { repository, commit: commit.toLowerCase() } }),
          )
        },
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
