import { Effect } from 'effect'

import {
  agentsControlPlaneStatusErrorDetails,
  describeAgentsControlPlaneStatusError,
  getAgentsControlPlaneStatusEffect,
  makeAgentsControlPlaneStatusLayer,
  type AgentsControlPlaneStatusDependencies,
} from '../control-plane-status'
import { errorResponse, okResponse } from '../http'
import { normalizeNamespace } from '../primitives'

export const buildControlPlaneStatusResponse = async (
  request: Request,
  deps: AgentsControlPlaneStatusDependencies = {},
) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')

  const result = await Effect.runPromise(
    getAgentsControlPlaneStatusEffect({
      namespace,
      service: 'agents',
    }).pipe(Effect.provide(makeAgentsControlPlaneStatusLayer(deps)), Effect.result),
  )

  if (result._tag === 'Success') {
    return okResponse(result.success)
  }

  return errorResponse(
    describeAgentsControlPlaneStatusError(result.failure),
    500,
    agentsControlPlaneStatusErrorDetails(result.failure, {
      namespace,
    }),
  )
}

export const getControlPlaneStatus = buildControlPlaneStatusResponse
