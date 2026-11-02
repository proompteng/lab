import { Effect } from 'effect'

import { READ_SCOPES, WRITE_SCOPES, destructiveAnnotations, readOnlyAnnotations, writeAnnotations } from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import {
  RepoSessionCloseInputSchema,
  RepoSessionCloseOutputSchema,
  RepoSessionInputSchema,
  RepoSessionOpenInputSchema,
  RepoSessionStatusSchema,
  type RepoSessionCloseInput,
  type RepoSessionInput,
  type RepoSessionOpenInput,
} from '../schemas'

export const createRepoSessionTools = (): EffectTool[] => [
  {
    name: 'repo_session_open',
    title: 'Open repo session',
    description:
      'Create an isolated branch and worktree from fresh origin/main and return a session id for repo tools.',
    inputSchema: RepoSessionOpenInputSchema,
    outputSchema: RepoSessionStatusSchema,
    annotations: writeAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: RepoSessionOpenInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => jsonTextResult(await runner.openRepoSession(args, auth)),
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'repo_session_status',
    title: 'Inspect repo session',
    description: 'Read branch, commit, dirty state, divergence, and worktree for an active repo session.',
    inputSchema: RepoSessionInputSchema,
    outputSchema: RepoSessionStatusSchema,
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: RepoSessionInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => jsonTextResult(await runner.repoSessionStatus(args.sessionId, auth)),
        catch: agentsShellErrorFromUnknown,
      }),
  },
  {
    name: 'repo_session_close',
    title: 'Close repo session',
    description: 'Remove a repo session worktree. Dirty sessions require force; the branch is retained.',
    inputSchema: RepoSessionCloseInputSchema,
    outputSchema: RepoSessionCloseOutputSchema,
    annotations: destructiveAnnotations,
    scopes: WRITE_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: (args: RepoSessionCloseInput, { runner, auth }) =>
      Effect.tryPromise({
        try: async () => jsonTextResult(await runner.closeRepoSession(args, auth)),
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
