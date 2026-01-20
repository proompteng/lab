import { EventEmitter } from 'node:events'

import type { AgentMessageRecord } from '~/server/agent-messages-store'

type AgentMessagesHandler = (records: AgentMessageRecord[]) => void

const emitter = new EventEmitter()
const EVENT_NAME = 'agent-messages'

emitter.setMaxListeners(50)

export const publishAgentMessages = (records: AgentMessageRecord[]) => {
  if (!records || records.length === 0) return
  emitter.emit(EVENT_NAME, records)
}

export const subscribeAgentMessages = (handler: AgentMessagesHandler) => {
  emitter.on(EVENT_NAME, handler)
  return () => emitter.off(EVENT_NAME, handler)
}
