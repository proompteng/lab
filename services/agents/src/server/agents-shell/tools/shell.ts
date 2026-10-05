import { Effect } from 'effect'

import {
  READ_SCOPES,
  WRITE_SCOPES,
  destructiveAnnotations,
  openReadOnlyAnnotations,
  shellAnnotations,
} from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { decodeOutputCursor, jobMetadata, listJobMetadata, readJobOutput } from '../jobs'
import { asPositiveInteger } from '../limits'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import {
  ExecInputSchema,
  ExecutionOutputSchema,
  JobMetadataSchema,
  CancelInputSchema,
  ReadInputSchema,
  StatusInputSchema,
  StatusOutputSchema,
  type ExecInput,
  type CancelInput,
  type ReadInput,
  type StatusInput,
} from '../schemas'

export const createShellTools = (): EffectTool[] => [
  {
    name: 'exec',
    title: 'Execute command',
    description:
      'Execute in an owned repo session once per requestKey; wait briefly, then return a running job or receipt. Continue with read and its cursor.',
    inputSchema: ExecInputSchema,
    outputSchema: ExecutionOutputSchema,
    annotations: shellAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: ExecInput, { config, runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const maxBytes = asPositiveInteger(
            args.maxBytes,
            'maxBytes',
            config.defaultOutputBytes,
            config.maxOutputBytes,
            4096,
          )
          const job = await runner.execute(args, auth)
          return jsonTextResult(
            readJobOutput(
              job,
              { jobId: job.id, stdoutOffset: 0, stderrOffset: 0, outputEncoding: args.outputEncoding ?? 'utf8' },
              maxBytes,
            ),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'read',
    title: 'Read execution output',
    description:
      'Read new output from the previous cursor; optionally wait for output or completion. Retention gaps are explicit.',
    inputSchema: ReadInputSchema,
    outputSchema: ExecutionOutputSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: ReadInput, { config, runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const cursor = decodeOutputCursor(args.cursor, args.jobId)
          if (args.outputEncoding) cursor.outputEncoding = args.outputEncoding
          const maxBytes = asPositiveInteger(
            args.maxBytes,
            'maxBytes',
            config.defaultOutputBytes,
            config.maxOutputBytes,
            4096,
          )
          const job = await runner.waitForOutput(args.jobId, auth, cursor, args.waitMs ?? 0)
          return jsonTextResult(readJobOutput(job, cursor, maxBytes))
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'cancel',
    title: 'Cancel execution',
    description:
      'Stop the process group with SIGTERM, then SIGKILL if needed. Return the terminal receipt; repeated cancellation is safe.',
    inputSchema: CancelInputSchema,
    outputSchema: JobMetadataSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: CancelInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => jsonTextResult(jobMetadata(await runner.cancel(args.jobId, auth))),
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'status',
    title: 'List executions',
    description:
      'List metadata without output or command bodies, in pages bounded to 8 KiB. Continue with cursor and the same filters.',
    inputSchema: StatusInputSchema,
    outputSchema: StatusOutputSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: StatusInput, { runner, auth }) =>
      Effect.try({
        try: () => {
          const jobs = args.jobId
            ? [runner.requireJob(args.jobId, auth)]
            : Array.from(runner.jobs.values()).filter(
                (job) =>
                  job.ownerSubject === auth.subject &&
                  (!args.sessionId || job.sessionId === args.sessionId) &&
                  (!args.agentId || job.agentId === args.agentId),
              )
          return jsonTextResult(listJobMetadata(jobs, args.cursor, args.limit ?? 20))
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
