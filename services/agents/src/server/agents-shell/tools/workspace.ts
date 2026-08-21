import { Effect } from 'effect'

import { READ_SCOPES, WRITE_SCOPES, destructiveAnnotations, openReadOnlyAnnotations } from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import {
  EmptyInputSchema,
  WorkspaceAcquireInputSchema,
  WorkspaceLeaseSchema,
  WorkspaceStatusOutputSchema,
  type WorkspaceAcquireInput,
} from '../schemas'

export const createWorkspaceTools = (): EffectTool[] => [
  {
    name: 'workspace_acquire',
    title: 'Acquire workspace lease',
    description: 'Acquire the one server-owned writable workspace for this MCP session.',
    inputSchema: WorkspaceAcquireInputSchema,
    outputSchema: WorkspaceLeaseSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: WorkspaceAcquireInput, { runner, auth, sessionId }) =>
      Effect.tryPromise({
        try: async () => jsonTextResult(await runner.acquireWorkspace(sessionId, auth, args)),
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'workspace_status',
    title: 'Read workspace lease',
    description: 'Read the current MCP session workspace lease and expiry.',
    inputSchema: EmptyInputSchema,
    outputSchema: WorkspaceStatusOutputSchema,
    annotations: openReadOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (_args, { runner, auth, sessionId }) =>
      Effect.try({
        try: () => jsonTextResult(runner.workspaceStatus(sessionId, auth)),
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'workspace_release',
    title: 'Release workspace lease',
    description: 'Release a clean session workspace; dirty workspaces are quarantined.',
    inputSchema: EmptyInputSchema,
    outputSchema: WorkspaceStatusOutputSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (_args, { runner, auth, sessionId }) =>
      Effect.tryPromise({
        try: async () => jsonTextResult(await runner.releaseWorkspace(sessionId, auth)),
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
