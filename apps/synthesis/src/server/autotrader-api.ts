import {
  AutotraderAppendEventInputSchema,
  AutotraderCreateTradeTicketInputSchema,
  AutotraderFinalizeSessionInputSchema,
  AutotraderGetScorecardInputSchema,
  AutotraderListSessionsInputSchema,
  AutotraderRecordFillInputSchema,
  AutotraderRecordOrderInputSchema,
  AutotraderRecordPositionSnapshotInputSchema,
  AutotraderRecordRiskCheckInputSchema,
  AutotraderStartSessionInputSchema,
  AutotraderUpsertStatusInputSchema,
} from './autotrader-schema'
import { getAutotraderStore } from './autotrader-store'
import { requireAuthorized } from './auth'
import { badRequest, jsonResponse, notFound, readJson } from './http'

const internalError = (error: unknown) =>
  jsonResponse({ error: error instanceof Error ? error.message : 'internal server error' }, { status: 500 })

const parseQuery = (request: Request) => {
  const url = new URL(request.url)
  return Object.fromEntries(url.searchParams.entries())
}

export const handleAutotraderListSessions = async (request: Request) => {
  const parsed = AutotraderListSessionsInputSchema.safeParse(parseQuery(request))
  if (!parsed.success) return badRequest('invalid autotrader sessions query')

  try {
    return jsonResponse({ sessions: await getAutotraderStore().listSessions(parsed.data.limit) })
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderGetSession = async (_request: Request, sessionId: string) => {
  try {
    const detail = await getAutotraderStore().getSessionDetail(sessionId)
    if (!detail) return notFound('autotrader session not found')
    return jsonResponse(detail)
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderGetScorecard = async (request: Request) => {
  const parsed = AutotraderGetScorecardInputSchema.safeParse(parseQuery(request))
  if (!parsed.success) return badRequest('invalid autotrader scorecard query')

  try {
    return jsonResponse(await getAutotraderStore().getScorecard(parsed.data))
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderStartSession = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, AutotraderStartSessionInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse({ session: await getAutotraderStore().startSession(parsed.value) }, { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderUpsertStatus = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, AutotraderUpsertStatusInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse({ status: await getAutotraderStore().upsertStatus(parsed.value) }, { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderAppendEvent = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, AutotraderAppendEventInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse({ event: await getAutotraderStore().appendEvent(parsed.value) }, { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderCreateTradeTicket = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, AutotraderCreateTradeTicketInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse({ ticket: await getAutotraderStore().createTradeTicket(parsed.value) }, { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderRecordRiskCheck = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, AutotraderRecordRiskCheckInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse({ riskCheck: await getAutotraderStore().recordRiskCheck(parsed.value) }, { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderRecordOrder = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, AutotraderRecordOrderInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse({ order: await getAutotraderStore().recordOrder(parsed.value) }, { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderRecordFill = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, AutotraderRecordFillInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse({ fill: await getAutotraderStore().recordFill(parsed.value) }, { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderRecordPositionSnapshot = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, AutotraderRecordPositionSnapshotInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse(
      { positionSnapshot: await getAutotraderStore().recordPositionSnapshot(parsed.value) },
      { status: 201 },
    )
  } catch (error) {
    return internalError(error)
  }
}

export const handleAutotraderFinalizeSession = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, AutotraderFinalizeSessionInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse(await getAutotraderStore().finalizeSession(parsed.value), { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}
