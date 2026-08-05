import { Effect } from 'effect'

import { WRITE_SCOPES, writeAnnotations } from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import { ApplyPatchInputSchema, ApplyPatchOutputSchema, type ApplyPatchInput } from '../schemas'

const extractCodexPatchPaths = (patch: string) => {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const fileMatch = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/)
    if (fileMatch) paths.add(fileMatch[1].trim())
  }
  return Array.from(paths)
}

const validateCodexPatch = (patch: string) => {
  if (!patch.trimStart().startsWith('*** Begin Patch')) {
    throw new Error("patch must start with '*** Begin Patch'")
  }
  if (!patch.trimEnd().endsWith('*** End Patch')) {
    throw new Error("patch must end with '*** End Patch'")
  }
  const paths = extractCodexPatchPaths(patch)
  if (paths.length === 0) throw new Error('patch does not contain recognizable Codex patch file paths')
  return paths
}

export const createPatchTools = (): EffectTool[] => [
  {
    name: 'apply_patch',
    title: 'Apply Codex patch',
    description: 'Edit files in the current leased workspace with Codex patch syntax.',
    inputSchema: ApplyPatchInputSchema,
    outputSchema: ApplyPatchOutputSchema,
    annotations: writeAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([WRITE_SCOPES[0]]),
    handler: (args: ApplyPatchInput, { runner, auth, sessionId }) =>
      Effect.tryPromise({
        try: async () => {
          const changedFiles = validateCodexPatch(args.patch)
          runner.leases.validateMutationPaths(sessionId, auth, args.cwd, changedFiles)
          const result = await runner.runProcess({
            command: 'apply_patch',
            args: [],
            cwd: args.cwd,
            stdin: args.patch,
            timeoutSeconds: args.timeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            auth,
            auditEvent: 'apply_patch',
            sessionId,
            mutation: true,
          })
          return jsonTextResult({ ...result, changedFiles })
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
