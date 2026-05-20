import { postAgentsJson, type EnvSource } from './agents-http'

export type AgentsAgentMessageInput = {
  agentRunUid: string | null
  agentRunName: string | null
  agentRunNamespace: string | null
  runId: string | null
  stepId: string | null
  agentId: string | null
  role: string
  kind: string
  timestamp: string | Date
  channel: string | null
  stage: string | null
  content: string
  attrs?: Record<string, unknown>
  dedupeKey?: string | null
}

export type AgentsAgentMessagesSubmitInput = {
  messages: AgentsAgentMessageInput[]
  skipIfExisting?: {
    runId?: string | null
    agentRunUid?: string | null
    agentRunName?: string | null
    agentRunNamespace?: string | null
  }
}

export type AgentsAgentMessagesSubmitResult = {
  inserted: number
  messages: Record<string, unknown>[]
  skipped: boolean
}

export const submitAgentMessagesToAgentsService = async (
  input: AgentsAgentMessagesSubmitInput,
  env: EnvSource = process.env,
): Promise<AgentsAgentMessagesSubmitResult> => {
  const result = await postAgentsJson<Record<string, unknown>>('/v1/agent-messages', input, { env })
  if (!result.ok) {
    const message = result.error ?? `Agents service returned HTTP ${result.status}`
    throw new Error(`Agents service agent messages submit failed (${result.status}): ${message}`)
  }

  const messages = Array.isArray(result.body.messages) ? result.body.messages : []
  return {
    inserted: typeof result.body.inserted === 'number' ? result.body.inserted : messages.length,
    messages: messages.filter((message): message is Record<string, unknown> => {
      return !!message && typeof message === 'object' && !Array.isArray(message)
    }),
    skipped: result.body.skipped === true,
  }
}
