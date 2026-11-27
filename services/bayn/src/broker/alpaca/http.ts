import { NodeHttpClient } from '@effect/platform-node'
import * as Undici from '@effect/platform-node/Undici'
import { Cause, Context, Effect, Layer, Redacted, Result, Schema, Scope } from 'effect'
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'

import { canonicalHashV1Result, renderCanonicalJsonFailure } from '../../hash'
import { currentUtcInstant } from '../../time'
import { withObservedStage } from '../../telemetry'
import { type BrokerConnection } from '../connection'
import { BrokerEnvironment } from '../identity'
import {
  BrokerReadContractFailure,
  BrokerReadError,
  BrokerReadErrorKind,
  configurationError,
  contractFailure,
  invalidRequest,
  invalidResponse,
  statusError,
  timeoutError,
  transportError,
  type BrokerReadOperation,
} from './failures'
import {
  ResponseHeadersSchema,
  decodeAccount,
  decodeAccountConfiguration,
  decodeAsset,
  decodeAssetSymbol,
  decodeErrorResponse,
  decodeExternalClientOrderId,
  decodeFillActivities,
  decodeFeeActivities,
  decodeFeeActivitiesQuery,
  decodeNonTradeActivityPage,
  decodeNonTradeActivityWindow,
  decodeFillActivitiesQuery,
  decodeMarketCalendar,
  decodeMarketCalendarQuery,
  decodeOrder,
  decodeOrderId,
  decodeOrders,
  decodeOrdersQuery,
  decodePositions,
  redactedHeaders,
  NonTradeActivityStatementSchema,
  nonTradeActivityInScope,
  verifyNonTradeActivityStatement,
  responseParseOptions,
  SortDirection,
  type BrokerReadShape,
  type Decoder,
  type FillActivitiesQuery,
  type FeeActivitiesQuery,
  type MarketCalendarQuery,
  type OrdersQuery,
  type ProxyDispatcherDependencies,
  type ReadEvidence,
  type ReadResult,
} from './model'
import {
  normalizeAccountConfigurationResult,
  normalizeAccountResult,
  normalizeAssetResult,
  normalizeFillActivitiesResult,
  normalizeFeeActivitiesResult,
  normalizeMarketCalendarResult,
  normalizeOrderResult,
  normalizeOrdersResult,
  normalizePositionsResult,
} from './normalizers'
import {
  accountConfigurationUrl,
  accountUrl,
  assetBySymbolUrl,
  fillActivitiesRequest,
  feeActivitiesRequest,
  marketCalendarUrl,
  orderByClientIdUrl,
  orderByIdUrl,
  ordersUrl,
  positionsUrl,
  responseEvidenceResult,
} from './requests'

import { makeReadDiagnostics, projectReadDiagnostic, type ReadDiagnostic } from './read-diagnostics'
import { positionDecodeDiagnostic } from './response-decode-diagnostics'
import {
  readTransportInterceptor,
  withReadTransportCoverage,
  withReadTransportDiagnostics,
} from './transport-diagnostics'

const decodeResponseHeaders = HttpClientResponse.schemaHeaders(ResponseHeadersSchema, responseParseOptions)
// Calendar discovery must leave time for the rest of the bounded recovery pass.
const marketCalendarTimeoutMs = 5_000
// Retry a stuck read before it consumes the observation's whole freshness lead.
// The read below still bounds headers, retries, body decoding and validation together.
const readAttemptTimeoutMs = 5_000
export class AlpacaHttpClient extends Context.Service<AlpacaHttpClient, HttpClient.HttpClient>()(
  '@proompteng/bayn/broker/alpaca/http/AlpacaHttpClient',
) {}

const decodeInput = <A>(
  operation: BrokerReadOperation,
  decoder: Decoder<A>,
  input: unknown,
  message: string,
): Effect.Effect<A, BrokerReadError> =>
  Effect.fromResult(decoder(input)).pipe(Effect.mapError((cause) => invalidRequest(operation, message, cause)))

const normalizeRead = <A>(
  operation: BrokerReadOperation,
  evidence: ReadEvidence,
  result: Result.Result<A, BrokerReadContractFailure>,
): Effect.Effect<ReadResult<A>, BrokerReadError> =>
  Effect.fromResult(result).pipe(
    Effect.map((value) => ({ value, evidence })),
    Effect.mapError((cause) =>
      invalidResponse({
        operation,
        message: `Alpaca ${operation} response violates the Bayn read contract`,
        evidence,
        cause,
      }),
    ),
  )

const defaultProxyDispatcherDependencies: ProxyDispatcherDependencies = {
  // Normal quota-paced polls are about fifteen seconds apart; the four-second default reconnects every poll.
  create: (url) =>
    new Undici.ProxyAgent({ uri: url.toString(), keepAliveTimeout: 30_000, keepAliveMaxTimeout: 30_000 }),
  destroy: (dispatcher) => dispatcher.destroy(),
}

const makeVerifiedProxyDispatcher = (
  proxyUrl: string,
  dependencies: ProxyDispatcherDependencies = defaultProxyDispatcherDependencies,
): Effect.Effect<Undici.Dispatcher, BrokerReadError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => dependencies.create(new URL(proxyUrl)),
      catch: (cause) =>
        configurationError({ operation: 'proxy', message: 'Alpaca proxy dispatcher acquisition failed', cause }),
    }),
    (dispatcher) => Effect.promise(() => dependencies.destroy(dispatcher)),
  )

export const alpacaHttpLayer = (
  connection: BrokerConnection,
  dependencies: ProxyDispatcherDependencies = defaultProxyDispatcherDependencies,
): Layer.Layer<HttpClient.HttpClient, BrokerReadError> =>
  HttpClient.layerMergedContext(
    Effect.gen(function* () {
      const rawDispatcher = yield* NodeHttpClient.Dispatcher
      // Bun's compatibility dispatcher lacks interceptors; preserve that fallback and report its coverage.
      const interceptorAvailable = typeof rawDispatcher.compose === 'function'
      const dispatcher = interceptorAvailable ? rawDispatcher.compose(readTransportInterceptor) : rawDispatcher
      const client = yield* NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, dispatcher))
      // A composed dispatcher reaching this point installed the interceptor successfully, not necessarily invoked it.
      return HttpClient.transformResponse(client, withReadTransportCoverage(interceptorAvailable))
    }),
  ).pipe(
    Layer.provide(
      Layer.effect(NodeHttpClient.Dispatcher, makeVerifiedProxyDispatcher(connection.proxyUrl, dependencies)),
    ),
  )

export const make = (connection: BrokerConnection) =>
  Effect.gen(function* () {
    const key = Redacted.value(connection.key)
    const secret = Redacted.value(connection.secret)
    const sensitiveValues = [key, secret]
    const baseClient = yield* HttpClient.HttpClient
    const observeDiagnostic = yield* makeReadDiagnostics(connection.identity)

    const readResponse = <A, E extends Schema.SchemaError | BrokerReadContractFailure>(
      operation: BrokerReadOperation,
      url: URL,
      decoder: (input: unknown) => Result.Result<A, E>,
      timeoutMs = connection.operationTimeoutMs,
    ): Effect.Effect<ReadResult<A> & { readonly diagnostic?: ReadDiagnostic }, BrokerReadError> => {
      // A shorter whole-read deadline owns cancellation; an equal attempt timer can race it into another retry.
      const bounded =
        timeoutMs > readAttemptTimeoutMs ? baseClient.pipe(HttpClient.timeout(readAttemptTimeoutMs)) : baseClient
      const client = bounded.pipe(HttpClient.retryTransient({ times: connection.retryAttempts }))
      return Effect.gen(function* () {
        const request = HttpClientRequest.get(url, {
          acceptJson: true,
          headers: {
            'APCA-API-KEY-ID': key,
            'APCA-API-SECRET-KEY': secret,
          },
        })
        const response = yield* client.execute(request).pipe(
          withReadTransportDiagnostics(operation),
          withObservedStage('bayn.alpaca.read.headers', { dependency: 'alpaca', operation, diagnosticOnly: true }),
          Effect.mapError((cause) => transportError(operation, cause, sensitiveValues)),
        )
        const headers = yield* decodeResponseHeaders(response).pipe(
          Effect.mapError((cause) =>
            invalidResponse({
              operation,
              message: `Alpaca ${operation} response headers are invalid`,
              evidence: { status: response.status },
              cause,
            }),
          ),
        )
        const raw = yield* response.json.pipe(
          withObservedStage('bayn.alpaca.read.body', { dependency: 'alpaca', operation, diagnosticOnly: true }),
          Effect.mapError((cause) =>
            invalidResponse({
              operation,
              message: `Alpaca ${operation} response body is not valid JSON`,
              evidence: { status: response.status, requestId: headers['x-request-id'] },
              cause,
            }),
          ),
        )
        const contentHash = yield* Effect.fromResult(
          Result.mapError(canonicalHashV1Result(raw), (failure) =>
            contractFailure({
              reason: 'CANONICAL_HASH',
              message: `Alpaca ${operation} response cannot be canonically hashed: ${renderCanonicalJsonFailure(failure)}`,
              facts: { field: 'response.body', actual: failure.path },
            }),
          ),
        ).pipe(
          Effect.mapError((cause) =>
            invalidResponse({
              operation,
              message: `Alpaca ${operation} response cannot be canonically hashed`,
              evidence: { status: response.status, requestId: headers['x-request-id'] },
              cause,
            }),
          ),
        )
        const observedAt = yield* currentUtcInstant
        const evidence = yield* Effect.fromResult(
          responseEvidenceResult(headers, response.status, contentHash, observedAt),
        ).pipe(
          Effect.mapError((cause) =>
            invalidResponse({
              operation,
              message: `Alpaca ${operation} rate-limit metadata is invalid`,
              evidence: { status: response.status, requestId: headers['x-request-id'], contentHash, observedAt },
              cause,
            }),
          ),
        )

        if (response.status < 200 || response.status >= 300) {
          const failure = yield* Effect.fromResult(decodeErrorResponse(raw)).pipe(
            Effect.mapError((cause) =>
              invalidResponse({ operation, message: `Alpaca ${operation} error response is invalid`, evidence, cause }),
            ),
          )
          return yield* statusError(
            operation,
            response.status,
            evidence.requestId,
            contentHash,
            evidence.observedAt,
            failure.code,
            failure.message,
          )
        }

        const value = yield* Effect.fromResult(decoder(raw)).pipe(
          Effect.tapError((cause) => {
            if (operation !== 'positions' || cause instanceof BrokerReadContractFailure) return Effect.void
            const diagnostic = positionDecodeDiagnostic(cause, raw)
            const annotations = {
              'broker.decode_field': diagnostic.field,
              'broker.decode_issue': diagnostic.issue,
              'broker.decode_expected_type': diagnostic.expectedType,
              'broker.decode_actual_type': diagnostic.actualType,
            }
            return Effect.annotateCurrentSpan(annotations).pipe(
              Effect.andThen(
                Effect.logWarning('Broker positions response schema rejected').pipe(Effect.annotateLogs(annotations)),
              ),
              // Optional telemetry cannot replace the provider rejection; cancellation must still interrupt.
              Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.void)),
            )
          }),
          Effect.mapError((cause) =>
            invalidResponse({
              operation,
              message: `Alpaca ${operation} response body does not match its schema`,
              evidence,
              cause,
            }),
          ),
        )
        yield* Effect.annotateCurrentSpan({
          'broker.operation': operation,
          'broker.request_id': evidence.requestId,
          'broker.status': evidence.status,
          'broker.content_hash': evidence.contentHash,
        })
        const diagnostic =
          connection.identity.environment === BrokerEnvironment.Sandbox
            ? projectReadDiagnostic(operation, raw)
            : undefined
        return { value, evidence, ...(diagnostic === undefined ? {} : { diagnostic }) }
      }).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError((cause) =>
          cause instanceof BrokerReadError
            ? cause
            : Cause.isTimeoutError(cause)
              ? timeoutError(operation, timeoutMs, cause, sensitiveValues)
              : transportError(operation, cause, sensitiveValues),
        ),
        Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders),
        withObservedStage('bayn.alpaca.read', { dependency: 'alpaca', operation }),
        Effect.annotateLogs({ operation }),
        Effect.withSpan('broker.read', { attributes: { 'broker.system': 'alpaca', 'broker.operation': operation } }),
      )
    }

    const accountWithBody = readResponse('account', accountUrl(connection), (body) =>
      Result.map(decodeAccount(body), (account) => ({ account, body })),
    ).pipe(
      Effect.flatMap((result) => {
        const normalized = normalizeAccountResult(
          result.value.account,
          connection.expectedAccountId,
          result.evidence.observedAt,
        )
        if (Result.isFailure(normalized) && normalized.failure.reason === 'ACCOUNT_BINDING') {
          return Effect.fail(
            new BrokerReadError({
              operation: 'account',
              kind: BrokerReadErrorKind.AccountMismatch,
              message: `Alpaca credential resolved account ${result.value.account.id}, expected ${connection.expectedAccountId}`,
              retryable: false,
              status: result.evidence.status,
              requestId: result.evidence.requestId,
              contentHash: result.evidence.contentHash,
              observedAt: result.evidence.observedAt,
              cause: normalized.failure,
            }),
          )
        }
        return normalizeRead('account', result.evidence, normalized).pipe(
          Effect.tap(() => observeDiagnostic(result.diagnostic, result.evidence)),
          Effect.map((read) => ({ ...read, body: result.value.body })),
        )
      }),
    )
    const account = accountWithBody.pipe(Effect.map(({ body: _body, ...read }) => read))

    const accountConfiguration = readResponse(
      'account-configuration',
      accountConfigurationUrl(connection),
      decodeAccountConfiguration,
    ).pipe(
      Effect.flatMap((result) =>
        normalizeRead(
          'account-configuration',
          result.evidence,
          normalizeAccountConfigurationResult(result.value, result.evidence.observedAt),
        ),
      ),
    )

    const positions = readResponse('positions', positionsUrl(connection), decodePositions).pipe(
      Effect.flatMap((result) =>
        normalizeRead(
          'positions',
          result.evidence,
          normalizePositionsResult(result.value, connection.expectedAccountId, result.evidence.observedAt),
        ),
      ),
    )

    const assetBySymbol = (symbol: string) =>
      decodeInput('asset-by-symbol', decodeAssetSymbol, symbol, 'invalid Alpaca asset symbol').pipe(
        Effect.flatMap((decoded) =>
          readResponse('asset-by-symbol', assetBySymbolUrl(connection, decoded), decodeAsset).pipe(
            Effect.map((result) => ({ decoded, result })),
          ),
        ),
        Effect.flatMap(({ decoded, result }) =>
          normalizeRead(
            'asset-by-symbol',
            result.evidence,
            normalizeAssetResult(result.value, decoded, result.evidence.observedAt),
          ),
        ),
      )

    const marketCalendar = (query: MarketCalendarQuery) =>
      decodeInput('market-calendar', decodeMarketCalendarQuery, query, 'invalid Alpaca market calendar query').pipe(
        Effect.flatMap((decoded) =>
          readResponse(
            'market-calendar',
            marketCalendarUrl(connection, decoded),
            decodeMarketCalendar,
            Math.min(connection.operationTimeoutMs, marketCalendarTimeoutMs),
          ).pipe(Effect.map((result) => ({ decoded, result }))),
        ),
        Effect.flatMap(({ decoded, result }) =>
          normalizeRead('market-calendar', result.evidence, normalizeMarketCalendarResult(result.value, decoded)),
        ),
      )

    const orders = (query: OrdersQuery = {}) =>
      decodeInput('orders', decodeOrdersQuery, query, 'invalid Alpaca orders query').pipe(
        Effect.flatMap((decoded) => readResponse('orders', ordersUrl(connection, decoded), decodeOrders)),
        Effect.flatMap((result) =>
          normalizeRead(
            'orders',
            result.evidence,
            normalizeOrdersResult(result.value, connection.expectedAccountId, result.evidence.observedAt),
          ),
        ),
      )

    const orderById = (orderId: string) =>
      decodeInput('order-by-id', decodeOrderId, orderId, 'invalid Alpaca order ID').pipe(
        Effect.flatMap((decoded) => readResponse('order-by-id', orderByIdUrl(connection, decoded), decodeOrder)),
        Effect.flatMap((result) =>
          normalizeRead(
            'order-by-id',
            result.evidence,
            normalizeOrderResult(result.value, connection.expectedAccountId, result.evidence.observedAt),
          ),
        ),
      )

    const orderByClientId = (clientOrderId: string) =>
      decodeInput(
        'order-by-client-id',
        decodeExternalClientOrderId,
        clientOrderId,
        'invalid Alpaca client order ID',
      ).pipe(
        Effect.flatMap((decoded) =>
          readResponse('order-by-client-id', orderByClientIdUrl(connection, decoded), decodeOrder),
        ),
        Effect.flatMap((result) =>
          normalizeRead(
            'order-by-client-id',
            result.evidence,
            normalizeOrderResult(result.value, connection.expectedAccountId, result.evidence.observedAt),
          ),
        ),
      )

    const fillActivities = (query: FillActivitiesQuery = {}) =>
      decodeInput('fill-activities', decodeFillActivitiesQuery, query, 'invalid Alpaca fill activities query').pipe(
        Effect.flatMap((decoded) => {
          const request = fillActivitiesRequest(connection, decoded)
          return readResponse('fill-activities', request.url, decodeFillActivities).pipe(
            Effect.map((result) => ({ result, pageSize: request.pageSize })),
          )
        }),
        Effect.flatMap(({ pageSize, result }) =>
          Effect.fromResult(normalizeFillActivitiesResult(result.value, connection.expectedAccountId)).pipe(
            Effect.map((items) => {
              const lastItem = items.at(-1)
              return {
                value: {
                  items,
                  ...(items.length === pageSize && lastItem !== undefined
                    ? { nextPageToken: lastItem.activityId }
                    : {}),
                },
                evidence: result.evidence,
              }
            }),
            Effect.mapError((cause) =>
              invalidResponse({
                operation: 'fill-activities',
                message: 'Alpaca fill-activities response violates the Bayn read contract',
                evidence: result.evidence,
                cause,
              }),
            ),
          ),
        ),
      )

    const feeActivities = (query: FeeActivitiesQuery = {}) =>
      decodeInput('fee-activities', decodeFeeActivitiesQuery, query, 'invalid Alpaca fee activities query').pipe(
        Effect.flatMap((decoded) => {
          const request = feeActivitiesRequest(connection, decoded)
          return readResponse('fee-activities', request.url, decodeFeeActivities).pipe(
            Effect.map((result) => ({ result, pageSize: request.pageSize })),
          )
        }),
        Effect.flatMap(({ pageSize, result }) =>
          Effect.fromResult(normalizeFeeActivitiesResult(result.value, connection.expectedAccountId)).pipe(
            Effect.tap(() => observeDiagnostic(result.diagnostic, result.evidence)),
            Effect.map((items) => {
              const lastItem = items.at(-1)
              return {
                value: {
                  items,
                  ...(items.length === pageSize && lastItem !== undefined
                    ? { nextPageToken: lastItem.activityId }
                    : {}),
                },
                evidence: result.evidence,
              }
            }),
            Effect.mapError((cause) =>
              invalidResponse({
                operation: 'fee-activities',
                message: 'Alpaca fee-activities response violates the Bayn read contract',
                evidence: result.evidence,
                cause,
              }),
            ),
          ),
        ),
      )

    const nonTradeActivityStatement = Effect.fn('bayn.alpaca.non-trade-activity-statement')(function* (window: {
      readonly after: string
      readonly until: string
    }) {
      const operation = 'non-trade-activities'
      const bounds = yield* decodeInput(operation, decodeNonTradeActivityWindow, window, 'Invalid activity window')
      const now = yield* currentUtcInstant
      if (connection.environment !== BrokerEnvironment.Sandbox || bounds.until > now) {
        return yield* invalidRequest(operation, 'Financial activity capture requires a historical PAPER window', null)
      }
      const verifiedAccount = yield* accountWithBody
      const readDirection = (direction: SortDirection) =>
        Effect.gen(function* () {
          const pages = []
          const seen = new Set<string>()
          let pageToken: string | undefined
          for (let index = 0; index < 100; index++) {
            const request = fillActivitiesRequest(connection, {
              ...bounds,
              direction,
              ...(pageToken === undefined ? {} : { pageToken }),
            })
            request.url.pathname = '/v2/account/activities'
            request.url.searchParams.set('category', 'non_trade_activity')
            const { value, evidence } = yield* readResponse(operation, request.url, decodeNonTradeActivityPage)
            for (const row of value.rows) {
              if (seen.has(row.id) || !nonTradeActivityInScope(row, verifiedAccount.value.id, bounds)) {
                return yield* invalidResponse({
                  operation,
                  message: 'Alpaca returned an out-of-scope or repeated activity',
                  evidence,
                })
              }
              seen.add(row.id)
            }
            pages.push({ pageToken: pageToken ?? null, evidence, body: value.body })
            const lastItem = value.rows.at(-1)
            if (lastItem === undefined) return pages
            pageToken = lastItem.id
          }
          return yield* invalidResponse({
            operation,
            message: 'Alpaca non-trade activity pagination exceeded its bound',
          })
        })
      const firstPass = yield* readDirection(SortDirection.Ascending)
      const secondPass = yield* readDirection(SortDirection.Descending)
      const statement = yield* Schema.decodeUnknownEffect(NonTradeActivityStatementSchema)({
        schemaVersion: 'bayn.alpaca-non-trade-activity-statement.v2' as const,
        accountIdentityHash: connection.identity.identityHash,
        window: bounds,
        accountRead: verifiedAccount.evidence,
        accountBody: verifiedAccount.body,
        firstPass,
        secondPass,
        observedAt: yield* currentUtcInstant,
      }).pipe(
        Effect.mapError(() =>
          invalidResponse({ operation, message: 'Alpaca activity statement has invalid structure' }),
        ),
      )
      yield* Effect.fromResult(verifyNonTradeActivityStatement(statement, verifiedAccount.value.id)).pipe(
        Effect.mapError((message) => invalidResponse({ operation, message })),
      )
      return statement
    })

    return {
      account,
      accountConfiguration,
      assetBySymbol,
      positions,
      orders,
      orderById,
      orderByClientId,
      fillActivities,
      feeActivities,
      marketCalendar,
      nonTradeActivityStatement,
    } satisfies BrokerReadShape & { readonly nonTradeActivityStatement: typeof nonTradeActivityStatement }
  })
