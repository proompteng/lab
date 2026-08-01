import { Effect, Layer } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import type { BrokerConnection } from '../connection'
import { BrokerReadError } from './failures'
import { AlpacaHttpClient, alpacaHttpLayer } from './http'
import {
  BrokerSession,
  BrokerSessionAcquisitionError,
  BrokerSessionAcquisitionStage,
  layer as brokerSessionLayer,
} from './session'
import { BrokerRead } from './model'

const brokerSessionAcquisitionError = (
  connection: BrokerConnection,
  cause: BrokerReadError,
): BrokerSessionAcquisitionError =>
  new BrokerSessionAcquisitionError({
    stage: BrokerSessionAcquisitionStage.Connection,
    provider: connection.provider,
    environment: connection.environment,
    baseUrl: connection.baseUrl,
    expectedAccountId: connection.expectedAccountId,
    cause,
  })

const mapHttpAcquisitionError = (
  connection: BrokerConnection,
  http: Layer.Layer<HttpClient.HttpClient, BrokerReadError>,
): Layer.Layer<HttpClient.HttpClient, BrokerSessionAcquisitionError> =>
  http.pipe(
    Layer.catchTag('BrokerReadError', (cause) =>
      Layer.effectContext(Effect.fail(brokerSessionAcquisitionError(connection, cause))),
    ),
  )

export const AlpacaBrokerResourcesLive = (
  connection: BrokerConnection,
  http: Layer.Layer<HttpClient.HttpClient, BrokerReadError> = alpacaHttpLayer(connection),
): Layer.Layer<BrokerSession | BrokerRead | AlpacaHttpClient, BrokerSessionAcquisitionError> => {
  const sharedHttp = mapHttpAcquisitionError(connection, http)
  const session = brokerSessionLayer(connection).pipe(Layer.provide(sharedHttp))
  const client = Layer.effect(AlpacaHttpClient, HttpClient.HttpClient).pipe(Layer.provide(sharedHttp))
  return Layer.merge(session, client)
}
