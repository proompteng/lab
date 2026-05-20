import { Effect, Layer } from 'effect'

import {
  AgentMessagesApiLive,
  AgentMessagesPublisher,
  AgentMessagesStoreFactory,
  describeAgentMessagesIngestError,
  ingestAgentMessagesEffect,
  parseAgentMessagesIngestPayload,
} from '../agent-messages-api'
import { errorResponse, okResponse, parseJsonBody } from '../http'

export const postAgentMessagesHandler = async (
  request: Request,
  layer: Layer.Layer<AgentMessagesStoreFactory | AgentMessagesPublisher, never, never> = AgentMessagesApiLive,
) => {
  try {
    let payload: Record<string, unknown>
    try {
      payload = await parseJsonBody(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResponse(message, 400)
    }
    const input = parseAgentMessagesIngestPayload(payload)
    const result = await Effect.runPromise(ingestAgentMessagesEffect(input).pipe(Effect.provide(layer)))
    return okResponse(
      {
        ok: true,
        inserted: result.inserted.length,
        messages: result.inserted,
        skipped: result.skipped,
      },
      result.skipped ? 200 : 201,
    )
  } catch (error) {
    const response = describeAgentMessagesIngestError(error)
    return errorResponse(response.message, response.status)
  }
}
