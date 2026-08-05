import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'

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

const readValidatedFilePrefix = (path: string, maxBytes: number) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`read_file supports regular files only: ${path}`)
    const openedPath = realpathSync(`/proc/self/fd/${fd}`)
    if (openedPath !== path) {
      throw new Error(`read_file path changed after validation: ${path}`)
    }
    const length = Math.min(stat.size, maxBytes)
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const bytesRead = readSync(fd, buffer, offset, length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return {
      content: buffer.subarray(0, offset).toString('utf8'),
      bytes: stat.size,
      truncated: stat.size > maxBytes,
    }
  } finally {
    closeSync(fd)
  }
}

export const createFileTools = (): EffectTool[] => [
  {
    name: 'search',
    title: 'Search files',
    description: 'Search the shared seed or current leased workspace with bounded ripgrep output.',
    inputSchema: SearchInputSchema,
    outputSchema: CommandResultSchema,
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: SearchInput, { config, runner, auth, sessionId }) =>
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
            timeoutSeconds: config.defaultTimeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            okExitCodes: [0, 1],
            auth,
            auditEvent: 'search',
            sessionId,
          })
          return jsonTextResult(result)
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'read_file',
    title: 'Read file',
    description: 'Read a bounded UTF-8 prefix from the shared seed or current leased workspace.',
    inputSchema: ReadFileInputSchema,
    outputSchema: ReadFileOutputSchema,
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: ReadFileInput, { config, runner, auth, sessionId }) =>
      Effect.try({
        try: () => {
          const path = runner.leases.resolveReadablePath(sessionId, auth, args.path)
          const maxBytes = asPositiveInteger(
            args.maxBytes,
            'maxBytes',
            config.defaultOutputBytes,
            config.maxOutputBytes,
            1,
          )
          const file = readValidatedFilePrefix(path, maxBytes)
          return jsonTextResult({
            path,
            ...file,
          })
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
