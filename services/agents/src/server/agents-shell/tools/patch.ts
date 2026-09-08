import { relative, resolve } from 'node:path'

import { Effect } from 'effect'

import { WRITE_SCOPES, writeAnnotations } from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import { ApplyPatchInputSchema, ApplyPatchOutputSchema, type ApplyPatchInput } from '../schemas'
import { isInsidePath, resolveExistingDirectory } from '../workspace-policy'

const extractCodexPatchPaths = (patch: string) => {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const fileMatch = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/)
    if (fileMatch) paths.add(fileMatch[1].trim())
  }
  return Array.from(paths)
}

const validateCodexPatch = (workspaceRoot: string, cwd: string, patch: string) => {
  if (!patch.trimStart().startsWith('*** Begin Patch')) {
    throw new Error("patch must start with '*** Begin Patch'")
  }
  if (!patch.trimEnd().endsWith('*** End Patch')) {
    throw new Error("patch must end with '*** End Patch'")
  }
  const paths = extractCodexPatchPaths(patch)
  if (paths.length === 0) throw new Error('patch does not contain recognizable Codex patch file paths')
  for (const path of paths) {
    const candidate = resolve(cwd, path)
    if (!isInsidePath(resolve(workspaceRoot), candidate)) {
      throw new Error(`patch path must stay under workspace: ${path}`)
    }
  }
  return paths
}

export const createPatchTools = (): EffectTool[] => [
  {
    name: 'apply_patch',
    title: 'Apply Codex patch',
    description:
      'Edit files under /workspace with Codex patch syntax. Pass the full *** Begin Patch / *** End Patch document.',
    inputSchema: ApplyPatchInputSchema,
    outputSchema: ApplyPatchOutputSchema,
    annotations: writeAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([WRITE_SCOPES[0]]),
    handler: (args: ApplyPatchInput, { config, runner, auth }) =>
      Effect.tryPromise({
        try: async () => {
          const cwd = resolveExistingDirectory(config.workspaceRoot, args.cwd ?? 'lab')
          const changedFiles = validateCodexPatch(config.workspaceRoot, cwd, args.patch)
          const result = await runner.runProcess({
            command: 'apply_patch',
            args: [],
            cwd: relative(resolve(config.workspaceRoot), cwd) || '.',
            stdin: args.patch,
            timeoutSeconds: args.timeoutSeconds,
            maxOutputBytes: args.maxOutputBytes,
            auth,
            auditEvent: 'apply_patch',
          })
          return jsonTextResult({ ...result, changedFiles })
        },
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
