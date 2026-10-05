import { Effect } from 'effect'

import { READ_SCOPES, WRITE_SCOPES, destructiveAnnotations, openReadOnlyAnnotations } from '../constants'
import { normalizeCliArgs, requireReadOnlyGitArgs } from '../cli-policy'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import { CliInputSchema, GitWriteInputSchema, CommandResultSchema, type CliInput, type GitWriteInput } from '../schemas'

export const createGitTools = (): EffectTool[] => [
  {
    name: 'git',
    title: 'Inspect git repository',
    description:
      'Inspect local Git metadata under /workspace. Pass argv after git. Use git_write with an owned session for ls-remote.',
    inputSchema: CliInputSchema,
    outputSchema: CommandResultSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: CliInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const gitArgs = normalizeCliArgs('git', args.args)
          requireReadOnlyGitArgs(gitArgs)
          return jsonTextResult(
            await runner.runProcess({
              command: 'git',
              args: gitArgs,
              cwd: args.cwd,
              sessionId: args.sessionId,
              timeoutSeconds: args.timeoutSeconds,
              maxOutputBytes: args.maxOutputBytes,
              auth,
              auditEvent: 'git',
            }),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'git_write',
    title: 'Execute Git in repo session',
    description:
      'Run Git commands that may change files or execute configured helpers. Pass argv after git and an owned sessionId.',
    inputSchema: GitWriteInputSchema,
    outputSchema: CommandResultSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: GitWriteInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const gitArgs = normalizeCliArgs('git_write', args.args)
          return jsonTextResult(
            await runner.runProcess({
              command: 'git',
              args: gitArgs,
              cwd: args.cwd,
              sessionId: args.sessionId,
              timeoutSeconds: args.timeoutSeconds,
              maxOutputBytes: args.maxOutputBytes,
              auth,
              auditEvent: 'git_write',
            }),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
