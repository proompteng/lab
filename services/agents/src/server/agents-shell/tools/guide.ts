import { Effect } from 'effect'

import { AGENT_GUIDE, READ_SCOPES, readOnlyAnnotations } from '../constants'
import { agentsShellErrorFromUnknown } from '../errors'
import { toolSecurityMeta, type EffectTool } from '../mcp-adapter'
import { jsonTextResult } from '../results'
import { AgentGuideOutputSchema, EmptyInputSchema } from '../schemas'

export const createGuideTools = (): EffectTool[] => [
  {
    name: 'agent_guide',
    title: 'Read agent guide',
    description: 'Read the repo-agent workflow guide for direct tools and delegated AgentRuns.',
    inputSchema: EmptyInputSchema,
    outputSchema: AgentGuideOutputSchema,
    annotations: readOnlyAnnotations,
    scopes: READ_SCOPES,
    ...toolSecurityMeta([READ_SCOPES[0]]),
    handler: () =>
      Effect.try({
        try: () => jsonTextResult({ guide: AGENT_GUIDE }),
        catch: agentsShellErrorFromUnknown,
      }),
  },
]
