import { ByteSize, Effect, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpIncomingMessage } from 'effect/http'

import { operationalError, retryableOperationalError } from '../errors'
import { ExecutionControllerHealthSchema } from '../execution/controller-health'
import type { ExecutionControllerStatusStoreShape } from '../execution/controller-status'
import { strictParseOptions } from '../schemas'
import type { ExecutionControllerProbe } from './model'

const decodeHealth = HttpClientResponse.schemaBodyJson(
  Schema.NullOr(ExecutionControllerHealthSchema),
  strictParseOptions,
)

export const makeExecutionControllerHealthReader =
  (
    http: HttpClient.HttpClient,
    ingressOrigin: string,
    readStatus: ExecutionControllerStatusStoreShape['read'],
    operationTimeoutMs: number,
  ): ExecutionControllerProbe['read'] =>
  (controllerKey) =>
    Effect.gen(function* () {
      const response = yield* HttpClient.withScope(http)
        .execute(
          HttpClientRequest.post(
            new URL(`/BaynExecutionController/${encodeURIComponent(controllerKey)}/health`, ingressOrigin).href,
          ).pipe(HttpClientRequest.bodyText('{}', 'application/json'), HttpClientRequest.acceptJson),
        )
        .pipe(
          Effect.mapError((cause) =>
            operationalError({
              component: 'http',
              operation: 'execution-controller-health',
              message: 'execution controller operational health request failed',
              cause,
            }),
          ),
        )
      if (response.status !== 200)
        return yield* operationalError({
          component: 'http',
          operation: 'execution-controller-health',
          message: `execution controller operational health returned HTTP ${response.status}`,
        })
      const operational = yield* decodeHealth(response).pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(4)),
        Effect.mapError(() =>
          operationalError({
            component: 'http',
            operation: 'execution-controller-health',
            message: 'execution controller operational health response is invalid',
          }),
        ),
      )
      // A completion is committed before the controller advances its durable state. Read that state first so a
      // later SQL snapshot cannot lag a completion already observed through the operational view.
      const status = yield* readStatus(controllerKey)
      return { operational, status }
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: operationTimeoutMs,
        orElse: () =>
          Effect.fail(
            retryableOperationalError({
              component: 'http',
              operation: 'execution-controller-health',
              message: `execution controller health read timed out after ${operationTimeoutMs}ms`,
            }),
          ),
      }),
    )
