import { readFileSync } from 'node:fs'

import { Effect } from 'effect'

import { DEFAULT_WORKSPACE_SEARCH_EXCLUDES, READ_SCOPES, readOnlyAnnotations } from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { asPositiveInteger } from '../limits'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import {
  CommandResultSchema,
  ReadFileInputSchema,
  ReadFileOutputSchema,
  SearchInputSchema,
  type ReadFileInput,
  type SearchInput,
} from '../schemas'
import { resolveWorkspacePath } from '../workspace-policy'

export const createFileTools = (): EffectTool[] => [
  {
    name: 'search',
    title: 'Search files',
    description:
      'Search text under /workspace with rg. Output is bounded and dependency/cache/generated dirs are skipped.',
    inputSchema: SearchInputSchema,
    outputSchema: CommandResultSchema,
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: SearchInput, { config, runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const rgArgs = ['--line-number', '--no-heading', '--color=never', '--hidden']
          for (const exclude of DEFAULT_WORKSPACE_SEARCH_EXCLUDES) {
            rgArgs.push('-g', `!${exclude}/**`)
          }
          if (args.fixedStrings) rgArgs.push('--fixed-strings')
          if (args.caseSensitive === false) rgArgs.push('--ignore-case')
          rgArgs.push(args.query)
          rgArgs.push('.')
          const result = await runner.runProcess({
            command: 'rg',
            args: rgArgs,
            cwd: args.path,
            sessionId: args.sessionId,
            timeoutSeconds: config.defaultTimeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            okExitCodes: [0, 1],
            auth,
            auditEvent: 'search',
          })
          return jsonTextResult(result)
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'read_file',
    title: 'Read file',
    description: 'Read a bounded UTF-8 prefix from a file under /workspace.',
    inputSchema: ReadFileInputSchema,
    outputSchema: ReadFileOutputSchema,
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: ReadFileInput, { config, runner, auth }) =>
      Effect.try({
        try: () => {
          const path = args.sessionId
            ? resolveWorkspacePath(runner.resolveRoot(args.sessionId, auth), args.path)
            : resolveWorkspacePath(config.workspaceRoot, args.path)
          const maxBytes = asPositiveInteger(
            args.maxBytes,
            'maxBytes',
            config.defaultOutputBytes,
            config.maxOutputBytes,
            1,
          )
          const buffer = readFileSync(path)
          const slice = buffer.subarray(0, maxBytes)
          return jsonTextResult({
            path,
            content: slice.toString('utf8'),
            bytes: buffer.length,
            truncated: buffer.length > maxBytes,
          })
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
