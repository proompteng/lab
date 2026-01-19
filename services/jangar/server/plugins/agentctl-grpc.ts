import { defineNitroPlugin } from 'nitro/runtime'
import { startAgentctlGrpcServer } from '../../src/server/agentctl-grpc'

export default defineNitroPlugin(() => {
  const instance = startAgentctlGrpcServer()
  if (!instance) return

  const shutdown = () => {
    instance.server.tryShutdown((error) => {
      if (error) {
        console.error('[jangar] agentctl grpc shutdown failed', error)
      }
    })
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
})
