import { proxyAgentsServiceRequest } from '~/server/agents-service-proxy'

const AGENTS_SERVICE_PATH = '/api/agents/implementation-sources/webhooks'

export const proxyImplementationSourceWebhook = (request: Request, provider: string) =>
  proxyAgentsServiceRequest(request, `${AGENTS_SERVICE_PATH}/${provider}`)
