import { Effect } from 'effect'

import {
  READ_SCOPES,
  WRITE_SCOPES,
  destructiveAnnotations,
  openReadOnlyAnnotations,
  shellAnnotations,
} from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { summarizeJob } from '../jobs'
import { asPositiveInteger } from '../limits'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import {
  ShellInputSchema,
  ShellJobSchema,
  ShellKillInputSchema,
  ShellReadInputSchema,
  ShellStatusInputSchema,
  ShellStatusOutputSchema,
  type ShellInput,
  type ShellKillInput,
  type ShellReadInput,
  type ShellStatusInput,
} from '../schemas'

export const createShellTools = (): EffectTool[] => [
  {
    name: 'shell_run',
    title: 'Run shell command',
    description: 'Run a short shell command. Default timeout 60s; server cap 1800s. Returns output and job metadata.',
    inputSchema: ShellInputSchema,
    outputSchema: ShellJobSchema,
    annotations: shellAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: ShellInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const input = runner.parseCommandInput(args)
          const job = await runner.run(input, auth)
          return jsonTextResult(summarizeJob(job, input.maxOutputBytes))
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'shell_start',
    title: 'Start shell job',
    description: 'Start a long-running command. Default timeout 60s; server cap 1800s. Poll with shell_read/status.',
    inputSchema: ShellInputSchema,
    outputSchema: ShellJobSchema,
    annotations: shellAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: ShellInput, { runner, auth }) =>
      Effect.try({
        try: () => {
          const input = runner.parseCommandInput(args)
          const job = runner.start(input, auth)
          return jsonTextResult(summarizeJob(job, input.maxOutputBytes))
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'shell_read',
    title: 'Read shell job',
    description: 'Read status and retained stdout/stderr for a shell_start job.',
    inputSchema: ShellReadInputSchema,
    outputSchema: ShellJobSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: ShellReadInput, { config, runner }) =>
      Effect.try({
        try: () => {
          const maxOutputBytes = asPositiveInteger(
            args.maxOutputBytes,
            'maxOutputBytes',
            config.defaultOutputBytes,
            config.maxOutputBytes,
            1024,
          )
          return jsonTextResult(
            summarizeJob(runner.requireJob(args.jobId), maxOutputBytes, {
              stdoutOffset: args.stdoutOffset ?? null,
              stderrOffset: args.stderrOffset ?? null,
            }),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'shell_kill',
    title: 'Kill shell job',
    description: 'Terminate a running shell_start job.',
    inputSchema: ShellKillInputSchema,
    outputSchema: ShellJobSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: ShellKillInput, { config, runner, auth }) =>
      Effect.try({
        try: () => {
          const job = runner.kill(args.jobId, auth, args.signal ?? 'SIGTERM')
          return jsonTextResult(summarizeJob(job, config.defaultOutputBytes))
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'shell_status',
    title: 'List shell jobs',
    description: 'List recent shell jobs or inspect one job by id.',
    inputSchema: ShellStatusInputSchema,
    outputSchema: ShellStatusOutputSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: ShellStatusInput, { config, runner }) =>
      Effect.try({
        try: () => {
          const jobs = args.jobId
            ? [runner.requireJob(args.jobId)]
            : Array.from(runner.jobs.values())
                .slice(-asPositiveInteger(args.limit, 'limit', 20, 100, 1))
                .reverse()
          return jsonTextResult({ jobs: jobs.map((job) => summarizeJob(job, config.defaultOutputBytes)) })
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
