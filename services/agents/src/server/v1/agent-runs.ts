import { Effect } from 'effect'

import { errorResponse, okResponse } from '../http'
import { asString } from '../primitives'

import type { AgentRunsApiDependencies } from './agent-runs-dependencies'
import { submitAgentRunEffect } from './agent-run-submit'
import { agentRunSubmitDetails, agentRunSubmitStatus, describeAgentRunSubmitError } from './agent-run-errors'
import { listAgentRunsWithServicesEffect, makeAgentRunStoreLayer, type AgentRunListInput } from './agent-run-store'

const parseListLimit = (value: string | null) => {
  if (!value) return 50
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 50
  return Math.min(parsed, 500)
}

const parseStatusFilter = (value: string | null) => {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

const listAgentRunsEffect = (deps: Pick<AgentRunsApiDependencies, 'storeFactory'>, input: AgentRunListInput) =>
  listAgentRunsWithServicesEffect(input).pipe(Effect.provide(makeAgentRunStoreLayer(deps.storeFactory)))

export const getAgentRunsHandler = async (request: Request, deps: Pick<AgentRunsApiDependencies, 'storeFactory'>) => {
  const url = new URL(request.url)
  const agentName = asString(url.searchParams.get('agentId')) ?? asString(url.searchParams.get('agentName'))
  const statuses = parseStatusFilter(url.searchParams.get('status'))
  const limit = parseListLimit(url.searchParams.get('limit'))
  if (!agentName && statuses.length === 0) return errorResponse('agentId or status is required', 400)

  const result = await Effect.runPromise(listAgentRunsEffect(deps, { agentName, statuses, limit }).pipe(Effect.either))
  if (result._tag === 'Right') return okResponse({ ok: true, runs: result.right })
  return errorResponse(describeAgentRunSubmitError(result.left), agentRunSubmitStatus(result.left))
}

export const postAgentRunsHandler = async (request: Request, deps: AgentRunsApiDependencies) => {
  const leaderResponse = deps.requireLeaderForMutation?.() ?? null
  if (leaderResponse) return leaderResponse

  const result = await Effect.runPromise(submitAgentRunEffect(request, deps).pipe(Effect.either))
  if (result._tag === 'Right') {
    return okResponse(result.right.body, result.right.status)
  }
  return errorResponse(
    describeAgentRunSubmitError(result.left),
    agentRunSubmitStatus(result.left),
    agentRunSubmitDetails(result.left),
  )
}
