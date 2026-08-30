import { Effect } from 'effect'

import { READ_SCOPES, WRITE_SCOPES, destructiveAnnotations, readOnlyAnnotations } from '../constants'
import { normalizeCliArgs, requireReadOnlyGitArgs } from '../cli-policy'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import { CliInputSchema, CommandResultSchema, type CliInput } from '../schemas'

export const createGitTools = (): EffectTool[] => [
  {
    name: 'git',
    title: 'Inspect git repository',
    description: 'Run read-only git commands under /workspace. Pass argv after git.',
    inputSchema: CliInputSchema,
    outputSchema: CommandResultSchema,
    annotations: readOnlyAnnotations,
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
    title: 'Run mutating git',
    description: 'Run repository-changing git commands under /workspace. Pass argv after git.',
    inputSchema: CliInputSchema,
    outputSchema: CommandResultSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: CliInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const gitArgs = normalizeCliArgs('git_write', args.args)
          return jsonTextResult(
            await runner.runProcess({
              command: 'git',
              args: gitArgs,
              cwd: args.cwd,
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
