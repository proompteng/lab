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
    }).pipe(Effect.provide(makeAgentsControlPlaneStatusLayer(deps)), Effect.either),
  )

  if (result._tag === 'Right') {
    return okResponse(result.right)
  }

  return errorResponse(
    describeAgentsControlPlaneStatusError(result.left),
    500,
    agentsControlPlaneStatusErrorDetails(result.left, {
      namespace,
    }),
  )
}

export const getControlPlaneStatus = buildControlPlaneStatusResponse
