import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'

import { Effect } from 'effect'
import type * as Schema from 'effect/Schema'

import { READ_SCOPES, readOnlyAnnotations } from '../constants'
import { FILE_PAGE_LIMIT, inspectEvidence, readFileRange, summarizePostgresLog } from '../diagnostic-files'
import {
  EvidenceInputSchema,
  EvidenceOutputSchema,
  FileRangeInputSchema,
  FileRangeOutputSchema,
  PostgresLogInputSchema,
  PostgresLogOutputSchema,
} from '../diagnostic-schemas'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool, type EffectToolContext } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import { resolveWorkspacePath } from '../workspace-policy'

const readDiagnostic = <I extends { path: string; sessionId?: string }, O extends { path: string; sizeBytes: number }>(
  name: string,
  input: I,
  { runner, auth }: EffectToolContext,
  inspect: (root: string, input: I, authorize: (openedPath: string) => void) => O,
) =>
  Effect.try({
    try: () => {
      const root = runner.resolveRoot(input.sessionId, auth)
      const path = realpathSync(resolveWorkspacePath(root, input.path))
      runner.resolveCwd(dirname(path), input.sessionId, auth)
      const result = inspect(root, { ...input, path }, (openedPath) => {
        runner.resolveCwd(dirname(openedPath), input.sessionId, auth)
      })
      runner.audit('diagnostic_read', auth, {
        tool: name,
        pathHash: createHash('sha256').update(result.path).digest('hex'),
        sizeBytes: result.sizeBytes,
      })
      return jsonTextResult(result)
    },
    catch: agentsShellErrorFromUnknown,
  })

export const createDiagnosticTools = (): EffectTool[] => [
  {
    name: 'file_read_range',
    title: 'Read a bounded file page',
    description:
      'Read a version-bound UTF-8 workspace file page (200000 bytes max). Rejects path escapes and changed files. No processes or network.',
    inputSchema: FileRangeInputSchema,
    outputSchema: FileRangeOutputSchema,
    strictInput: true,
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (input: Schema.Schema.Type<typeof FileRangeInputSchema>, context) =>
      readDiagnostic('file_read_range', input, context, (root, args, authorize) => {
        const limit = Math.min(context.config.maxOutputBytes, FILE_PAGE_LIMIT)
        const maxBytes = args.maxBytes ?? Math.min(context.config.defaultOutputBytes, limit)
        if (maxBytes > limit) throw new Error(`maxBytes exceeds the configured ${limit}-byte page limit`)
        return readFileRange(root, { ...args, maxBytes }, authorize)
      }),
  },
  {
    name: 'evidence_inspect',
    title: 'Inspect JSON evidence integrity',
    description:
      'Validate JSON, NDJSON or multiline JSON streams (64 MiB max); return SHA-256 and counts, not payloads. No database or commands.',
    inputSchema: EvidenceInputSchema,
    outputSchema: EvidenceOutputSchema,
    strictInput: true,
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (input: Schema.Schema.Type<typeof EvidenceInputSchema>, context) =>
      readDiagnostic('evidence_inspect', input, context, inspectEvidence),
  },
  {
    name: 'postgres_log_summary',
    title: 'Summarize retained PostgreSQL logs',
    description:
      'Summarize a bounded PostgreSQL JSON log by UTC interval. Returns aggregates and coverage gaps, not SQL. No commands or network.',
    inputSchema: PostgresLogInputSchema,
    outputSchema: PostgresLogOutputSchema,
    strictInput: true,
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (input: Schema.Schema.Type<typeof PostgresLogInputSchema>, context) =>
      readDiagnostic('postgres_log_summary', input, context, summarizePostgresLog),
  },
]
