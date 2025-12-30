import { startAgentCommsSubscriber } from '~/server/agent-comms-subscriber'

export const ensureAgentCommsRuntime = () => {
  void startAgentCommsSubscriber().catch((error) => {
    console.warn('Agent comms subscriber failed to start', error)
  })
}

ensureAgentCommsRuntime()
