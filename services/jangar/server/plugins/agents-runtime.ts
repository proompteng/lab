import { defineNitroPlugin } from 'nitro/runtime'
import { ensureAgentCommsRuntime } from '../../src/server/agent-comms-runtime'

export default defineNitroPlugin(() => {
  ensureAgentCommsRuntime()
})
