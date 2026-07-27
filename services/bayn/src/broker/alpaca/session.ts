import { Context, Data, Effect, Layer, pipe } from 'effect'
import { HttpClient } from 'effect/unstable/http'

import type { BrokerConnection } from '../connection'
import { BrokerReadError } from './failures'
import { alpacaHttpLayer, make } from './http'
import { BrokerRead, type BrokerReadShape, type ReadPreflight } from './model'
import { BrokerAccountPreflightError, verifyReadAccess } from './preflight'

export enum BrokerSessionAcquisitionStage {
  Connection = 'CONNECTION',
  Account = 'ACCOUNT',
  Permissions = 'PERMISSIONS',
  ReadSurface = 'READ_SURFACE',
}

export class BrokerSessionAcquisitionError extends Data.TaggedError('BrokerSessionAcquisitionError')<{
  readonly stage: BrokerSessionAcquisitionStage
  readonly provider: BrokerConnection['provider']
  readonly environment: BrokerConnection['environment']
  readonly baseUrl: string
  readonly expectedAccountId: string
  readonly cause: BrokerReadError | BrokerAccountPreflightError
}> {}

export interface BrokerSessionShape {
  readonly connection: BrokerConnection
  readonly read: BrokerReadShape
  readonly preflight: ReadPreflight
}

export class BrokerSession extends Context.Service<BrokerSession, BrokerSessionShape>()('bayn/BrokerSession') {}

const acquisitionStage = (cause: BrokerReadError | BrokerAccountPreflightError): BrokerSessionAcquisitionStage => {
  if (cause instanceof BrokerAccountPreflightError) return BrokerSessionAcquisitionStage.Permissions
  switch (cause.operation) {
    case 'configuration':
    case 'proxy':
      return BrokerSessionAcquisitionStage.Connection
    case 'account':
      return BrokerSessionAcquisitionStage.Account
    case 'account-configuration':
      return BrokerSessionAcquisitionStage.Permissions
    case 'preflight':
    case 'positions':
    case 'orders':
    case 'order-by-id':
    case 'order-by-client-id':
    case 'fill-activities':
    case 'asset-by-symbol':
    case 'market-calendar':
      return BrokerSessionAcquisitionStage.ReadSurface
  }
  const exhaustive: never = cause.operation
  return exhaustive
}

const acquisitionError = (
  connection: BrokerConnection,
  cause: BrokerReadError | BrokerAccountPreflightError,
): BrokerSessionAcquisitionError =>
  new BrokerSessionAcquisitionError({
    stage: acquisitionStage(cause),
    provider: connection.provider,
    environment: connection.environment,
    baseUrl: connection.baseUrl,
    expectedAccountId: connection.expectedAccountId,
    cause,
  })

export const acquireBrokerSession = (
  connection: BrokerConnection,
): Effect.Effect<BrokerSessionShape, BrokerSessionAcquisitionError, HttpClient.HttpClient> =>
  pipe(
    make(connection),
    Effect.flatMap((read) =>
      pipe(
        verifyReadAccess(connection, read),
        Effect.map((preflight) => Object.freeze({ connection, read, preflight })),
      ),
    ),
    Effect.mapError((cause) => acquisitionError(connection, cause)),
    Effect.withLogSpan('broker.session.acquire'),
  )

export const layer = (
  connection: BrokerConnection,
): Layer.Layer<BrokerSession | BrokerRead, BrokerSessionAcquisitionError, HttpClient.HttpClient> => {
  const session = Layer.effect(BrokerSession, acquireBrokerSession(connection))
  return Layer.effect(
    BrokerRead,
    pipe(
      BrokerSession,
      Effect.map((brokerSession) => brokerSession.read),
    ),
  ).pipe(Layer.provideMerge(session))
}

const mapHttpAcquisitionError = (
  connection: BrokerConnection,
  http: Layer.Layer<HttpClient.HttpClient, BrokerReadError>,
): Layer.Layer<HttpClient.HttpClient, BrokerSessionAcquisitionError> =>
  Layer.unwrap(
    pipe(
      Layer.build(http),
      Effect.mapError((cause) => acquisitionError(connection, cause)),
      Effect.map(Layer.succeedContext),
    ),
  )

export const live = (
  connection: BrokerConnection,
): Layer.Layer<BrokerSession | BrokerRead, BrokerSessionAcquisitionError> =>
  layer(connection).pipe(Layer.provide(mapHttpAcquisitionError(connection, alpacaHttpLayer(connection))))
