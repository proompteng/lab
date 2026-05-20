import { Data, Effect, Layer } from 'effect'

import {
  AgentMessagesApiLive,
  AgentMessagesPublisher,
  AgentMessagesStoreFactory,
  describeAgentMessagesIngestError,
  ingestAgentMessagesEffect,
  parseAgentMessagesIngestPayload,
} from '../agent-messages-api'
import { errorResponse, okResponse, parseJsonBody } from '../http'

export class AgentMessagesJsonBodyError extends Data.TaggedError('AgentMessagesJsonBodyError')<{
  readonly message: string
}> {}

const parseJsonBodyEffect = (request: Request) =>
  Effect.tryPromise({
    try: () => parseJsonBody(request),
    catch: (error) =>
      new AgentMessagesJsonBodyError({ message: error instanceof Error ? error.message : String(error) }),
  })

const parseAgentMessagesIngestPayloadEffect = (payload: Record<string, unknown>) =>
  Effect.try({
    try: () => parseAgentMessagesIngestPayload(payload),
    catch: (error) => error,
  })

const agentMessagesErrorResponse = (error: unknown) => {
  if (error instanceof AgentMessagesJsonBodyError) {
    return errorResponse(error.message, 400)
  }

  const response = describeAgentMessagesIngestError(error)
  return errorResponse(response.message, response.status)
}

export const postAgentMessagesEffect = (
  request: Request,
  layer: Layer.Layer<AgentMessagesStoreFactory | AgentMessagesPublisher, never, never> = AgentMessagesApiLive,
) =>
  Effect.gen(function* () {
    const payload = yield* parseJsonBodyEffect(request)
    const input = yield* parseAgentMessagesIngestPayloadEffect(payload)
    const result = yield* ingestAgentMessagesEffect(input).pipe(Effect.provide(layer))
    return okResponse(
      {
        ok: true,
        inserted: result.inserted.length,
        messages: result.inserted,
        skipped: result.skipped,
      },
      result.skipped ? 200 : 201,
    )
  })

export const postAgentMessagesHandler = async (
  request: Request,
  layer: Layer.Layer<AgentMessagesStoreFactory | AgentMessagesPublisher, never, never> = AgentMessagesApiLive,
) =>
  Effect.runPromise(
    postAgentMessagesEffect(request, layer).pipe(
      Effect.catchAll((error) => Effect.succeed(agentMessagesErrorResponse(error))),
    ),
  )
