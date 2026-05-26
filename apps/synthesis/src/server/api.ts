import {
  ListFeedInputSchema,
  RecordFeedbackInputSchema,
  StartRunInputSchema,
  SubmitBatchInputSchema,
  SubmitItemInputSchema,
} from './schema'
import { assetResponseForAttachment } from './assets'
import { createCompanyDataProvider } from './company'
import { getSynthesisStore } from './store'
import { requireAuthorized } from './auth'
import { badRequest, jsonResponse, notFound, readJson } from './http'

const internalError = (error: unknown) =>
  jsonResponse({ error: error instanceof Error ? error.message : 'internal server error' }, { status: 500 })

const parseFeedQuery = (request: Request) => {
  const url = new URL(request.url)
  const parsed = ListFeedInputSchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    cursor: url.searchParams.get('cursor') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    minScore: url.searchParams.get('minScore') ?? undefined,
    query: url.searchParams.get('query') ?? url.searchParams.get('q') ?? undefined,
  })
  return parsed.success ? parsed.data : null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const handleCreateRun = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, StartRunInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse({ run: await getSynthesisStore().startRun(parsed.value) }, { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}

export const handleSubmitItem = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, SubmitItemInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse(await getSynthesisStore().submitItem(parsed.value), { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}

export const handleSubmitBatch = async (request: Request) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const parsed = await readJson(request, SubmitBatchInputSchema)
  if (parsed instanceof Response) return parsed

  try {
    return jsonResponse(await getSynthesisStore().submitBatch(parsed.value), { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}

export const handleListFeed = async (request: Request) => {
  const query = parseFeedQuery(request)
  if (!query) return badRequest('invalid feed query')

  try {
    return jsonResponse(await getSynthesisStore().listFeed(query))
  } catch (error) {
    return internalError(error)
  }
}

export const handleGetCompany = async (_request: Request, symbol: string) => {
  const provider = createCompanyDataProvider()
  if (!provider) {
    return jsonResponse({ error: 'company market data provider is not configured' }, { status: 503 })
  }

  try {
    return jsonResponse({ company: await provider.getCompanyAnalysis(symbol) })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'company analysis unavailable'
    if (message.startsWith('unsupported company symbol')) return badRequest(message)
    return jsonResponse({ error: message }, { status: 502 })
  }
}

export const handleGetItem = async (_request: Request, id: string) => {
  try {
    const item = await getSynthesisStore().getItem(id)
    if (!item) return notFound('synthesis item not found')
    return jsonResponse({ item })
  } catch (error) {
    return internalError(error)
  }
}

export const handleGetAsset = async (_request: Request, id: string) => {
  try {
    const attachment = await getSynthesisStore().getAttachment(id)
    if (!attachment) return notFound('asset not found')
    return assetResponseForAttachment(attachment)
  } catch (error) {
    return internalError(error)
  }
}

export const handleRecordFeedback = async (request: Request, id: string) => {
  const unauthorized = requireAuthorized(request)
  if (unauthorized) return unauthorized

  const raw = await request.json().catch(() => null)
  const parsed = RecordFeedbackInputSchema.safeParse({ id, ...(isRecord(raw) ? raw : {}) })
  if (!parsed.success) return badRequest('invalid request body')

  try {
    return jsonResponse({ feedback: await getSynthesisStore().recordFeedback(parsed.data) }, { status: 201 })
  } catch (error) {
    return internalError(error)
  }
}
