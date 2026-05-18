import { createFileRoute } from '@tanstack/react-router'
import { createAgentsHealthHandler } from '@proompteng/agents/server/health'
import { resolveRuntimeServiceName } from '@proompteng/agents/server/runtime-identity'
import { getAgentsControllerHealth } from '~/server/agents-controller'

export const getHealthHandler = createAgentsHealthHandler({
  getAgentsControllerHealth,
  resolveServiceName: resolveRuntimeServiceName,
})

export const Route = createFileRoute('/health')({
  server: {
    handlers: {
      GET: getHealthHandler,
    },
  },
})
