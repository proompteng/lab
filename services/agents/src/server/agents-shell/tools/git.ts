import { Effect } from 'effect'

import { READ_SCOPES, WRITE_SCOPES, destructiveAnnotations, readOnlyAnnotations } from '../constants'
import {
  normalizeCliArgs,
  prepareReadOnlyGitArgs,
  prepareReadOnlyGitRefreshArgs,
  requireContainedGitArgs,
} from '../cli-policy'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import { CliInputSchema, CommandResultSchema, type CliInput } from '../schemas'

export const createGitTools = (): EffectTool[] => [
  {
    name: 'git',
    title: 'Inspect git repository',
    description: 'Run confined read-only Git inspection in the seed or current leased workspace.',
    inputSchema: CliInputSchema,
    outputSchema: CommandResultSchema,
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: CliInput, { runner, auth, sessionId }) =>
      Effect.tryPromise({
        try: async () => {
          const normalized = normalizeCliArgs('git', args.args)
          return runner.withReadOnlyGitInspection(sessionId, auth, args.cwd, async (inspection) => {
            const refresh = await runner.runProcess({
              command: 'git',
              args: prepareReadOnlyGitRefreshArgs(inspection.gitHooksPath, inspection.configOverrides),
              cwd: inspection.cwd,
              timeoutSeconds: args.timeoutSeconds,
              maxOutputBytes: args.maxOutputBytes,
              okExitCodes: [0, 1],
              auth,
              auditEvent: 'git_index_refresh',
              sessionId,
              readOnlyGitConfigPath: inspection.gitConfigPath,
              readOnlyGitIndexPath: inspection.gitIndexPath,
              readOnlyScratchRoot: inspection.scratchRoot,
            })
            if (!refresh.ok) throw new Error(`read-only Git index refresh failed: ${refresh.stderr || refresh.stdout}`)
            return jsonTextResult(
              await runner.runProcess({
                command: 'git',
                args: prepareReadOnlyGitArgs(normalized, inspection.gitHooksPath, inspection.configOverrides),
                cwd: inspection.cwd,
                timeoutSeconds: args.timeoutSeconds,
                maxOutputBytes: args.maxOutputBytes,
                auth,
                auditEvent: 'git',
                sessionId,
                readOnlyGitConfigPath: inspection.gitConfigPath,
                readOnlyGitIndexPath: inspection.gitIndexPath,
                readOnlyScratchRoot: inspection.scratchRoot,
              }),
            )
          })
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'git_write',
    title: 'Run mutating git',
    description: 'Run confined repository-changing Git in the current leased workspace.',
    inputSchema: CliInputSchema,
    outputSchema: CommandResultSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: CliInput, { runner, auth, sessionId }) =>
      Effect.tryPromise({
        try: async () => {
          const gitArgs = normalizeCliArgs('git_write', args.args)
          requireContainedGitArgs(gitArgs)
          return jsonTextResult(
            await runner.runProcess({
              command: 'git',
              args: gitArgs,
              cwd: args.cwd,
              timeoutSeconds: args.timeoutSeconds,
              maxOutputBytes: args.maxOutputBytes,
              auth,
              auditEvent: 'git_write',
              sessionId,
              mutation: true,
            }),
          )
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
