import { NodeHttpClient, Undici } from '@effect/platform-node'
import { Cause, Effect, Layer, pipe, Redacted, Result, Scope } from 'effect'
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import { canonicalHashV1Result, renderCanonicalJsonFailure } from '../../hash'
import { currentUtcInstant } from '../../time'
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
  decodeFillActivitiesQuery,
  decodeMarketCalendar,
  decodeMarketCalendarQuery,
  decodeOrder,
  decodeOrderId,
  decodeOrders,
  decodeOrdersQuery,
  decodePositions,
  decodeRuntimeOptions,
  redactedHeaders,
  responseParseOptions,
  type BrokerReadShape,
  type Decoder,
  type FillActivitiesQuery,
  type MarketCalendarQuery,
  type OrdersQuery,
  type ProxyDispatcherDependencies,
  type ReadEvidence,
  type ReadOptions,
  type ReadResult,
} from './model'
import {
  normalizeAccountConfigurationResult,
  normalizeAccountResult,
  normalizeAssetResult,
  normalizeFillActivitiesResult,
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
  marketCalendarUrl,
  orderByClientIdUrl,
  orderByIdUrl,
  ordersUrl,
  positionsUrl,
  responseEvidenceResult,
} from './requests'

const decodeResponseHeaders = HttpClientResponse.schemaHeaders(ResponseHeadersSchema, responseParseOptions)

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
      invalidResponse(operation, `Alpaca ${operation} response violates the Bayn read contract`, evidence, cause),
    ),
  )

export const makeProxyDispatcher = (
  proxyUrl: string,
  dependencies: ProxyDispatcherDependencies = {
    create: (url) => new Undici.ProxyAgent({ uri: url.toString() }),
    destroy: (dispatcher) => dispatcher.destroy(),
  },
): Effect.Effect<Undici.Dispatcher, BrokerReadError, Scope.Scope> =>
  Effect.acquireRelease(
    pipe(
      Effect.fromResult(parseProxyUrl(proxyUrl)),
      Effect.flatMap((url) =>
        Effect.try({
          try: () => dependencies.create(url),
          catch: (cause) => configurationError('proxy', 'Alpaca proxy dispatcher acquisition failed', cause),
        }),
      ),
    ),
    (dispatcher) => Effect.promise(() => dependencies.destroy(dispatcher)),
  )

export const parseProxyUrl = (proxyUrl: string): Result.Result<URL, BrokerReadError> =>
  pipe(
    Result.try({
      try: () => new URL(proxyUrl),
      catch: (cause) => configurationError('proxy', 'invalid Alpaca proxy configuration', cause),
    }),
    Result.flatMap((url) => {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return Result.fail(configurationError('proxy', 'Alpaca proxy URL must use HTTP or HTTPS'))
      }
      if (url.username !== '' || url.password !== '') {
        return Result.fail(configurationError('proxy', 'Alpaca proxy credentials must not be embedded in the URL'))
      }
      if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
        return Result.fail(configurationError('proxy', 'Alpaca proxy URL must contain only an origin'))
      }
      return Result.succeed(url)
    }),
  )

const proxyLayer = (proxyUrl: string): Layer.Layer<NodeHttpClient.Dispatcher, BrokerReadError> =>
  Layer.effect(NodeHttpClient.Dispatcher, makeProxyDispatcher(proxyUrl))

export const alpacaHttpLayer = (proxyUrl: string): Layer.Layer<HttpClient.HttpClient, BrokerReadError> =>
  NodeHttpClient.layerUndiciNoDispatcher.pipe(Layer.provide(proxyLayer(proxyUrl)))

export const make = (options: ReadOptions): Effect.Effect<BrokerReadShape, BrokerReadError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.fromResult(
      decodeRuntimeOptions({
        expectedAccountId: options.expectedAccountId,
        operationTimeoutMs: options.operationTimeoutMs,
        retryAttempts: options.retryAttempts,
      }),
    ).pipe(Effect.mapError((cause) => configurationError('configuration', 'invalid Alpaca read options', cause)))
    const key = Redacted.value(options.key)
    const secret = Redacted.value(options.secret)
    if (key.length === 0 || key.trim() !== key || secret.length === 0 || secret.trim() !== secret) {
      return yield* Effect.fail(
        configurationError('configuration', 'Alpaca credentials must be non-empty without surrounding whitespace'),
      )
    }
    const sensitiveValues = [key, secret]
    const baseClient = yield* HttpClient.HttpClient
    const client = baseClient.pipe(HttpClient.retryTransient({ times: runtime.retryAttempts }))

    const readJson = <A>(
      operation: BrokerReadOperation,
      url: URL,
      decoder: Decoder<A>,
    ): Effect.Effect<ReadResult<A>, BrokerReadError> =>
      Effect.gen(function* () {
        const request = HttpClientRequest.get(url, {
          acceptJson: true,
          headers: {
            'APCA-API-KEY-ID': key,
            'APCA-API-SECRET-KEY': secret,
          },
        })
        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError((cause) => transportError(operation, cause, sensitiveValues)))
        const headers = yield* decodeResponseHeaders(response).pipe(
          Effect.mapError((cause) =>
            invalidResponse(
              operation,
              `Alpaca ${operation} response headers are invalid`,
              { status: response.status },
              cause,
            ),
          ),
        )
        const raw = yield* response.json.pipe(
          Effect.mapError((cause) =>
            invalidResponse(
              operation,
              `Alpaca ${operation} response body is not valid JSON`,
              { status: response.status, requestId: headers['x-request-id'] },
              cause,
            ),
          ),
        )
        const contentHash = yield* Effect.fromResult(
          Result.mapError(canonicalHashV1Result(raw), (failure) =>
            contractFailure(
              'CANONICAL_HASH',
              `Alpaca ${operation} response cannot be canonically hashed: ${renderCanonicalJsonFailure(failure)}`,
              { field: 'response.body', actual: failure.path },
            ),
          ),
        ).pipe(
          Effect.mapError((cause) =>
            invalidResponse(
              operation,
              `Alpaca ${operation} response cannot be canonically hashed`,
              { status: response.status, requestId: headers['x-request-id'] },
              cause,
            ),
          ),
        )
        const observedAt = yield* currentUtcInstant
        const evidence = yield* Effect.fromResult(
          responseEvidenceResult(headers, response.status, contentHash, observedAt),
        ).pipe(
          Effect.mapError((cause) =>
            invalidResponse(
              operation,
              `Alpaca ${operation} rate-limit metadata is invalid`,
              { status: response.status, requestId: headers['x-request-id'], contentHash, observedAt },
              cause,
            ),
          ),
        )

        if (response.status < 200 || response.status >= 300) {
          const failure = yield* Effect.fromResult(decodeErrorResponse(raw)).pipe(
            Effect.mapError((cause) =>
              invalidResponse(operation, `Alpaca ${operation} error response is invalid`, evidence, cause),
            ),
          )
          return yield* Effect.fail(
            statusError(
              operation,
              response.status,
              evidence.requestId,
              contentHash,
              evidence.observedAt,
              failure.code,
              failure.message,
            ),
          )
        }

        const value = yield* Effect.fromResult(decoder(raw)).pipe(
          Effect.mapError((cause) =>
            invalidResponse(operation, `Alpaca ${operation} response body does not match its schema`, evidence, cause),
          ),
        )
        yield* Effect.annotateCurrentSpan({
          'broker.operation': operation,
          'broker.request_id': evidence.requestId,
          'broker.status': evidence.status,
          'broker.content_hash': evidence.contentHash,
        })
        return { value, evidence }
      }).pipe(
        Effect.timeout(`${runtime.operationTimeoutMs} millis`),
        Effect.mapError((cause) =>
          cause instanceof BrokerReadError
            ? cause
            : Cause.isTimeoutError(cause)
              ? timeoutError(operation, runtime.operationTimeoutMs, cause, sensitiveValues)
              : transportError(operation, cause, sensitiveValues),
        ),
        Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders),
        Effect.withSpan('broker.read', { attributes: { 'broker.system': 'alpaca', 'broker.operation': operation } }),
      )

    const account = readJson('account', accountUrl(), decodeAccount).pipe(
      Effect.flatMap((result) => {
        const normalized = normalizeAccountResult(result.value, runtime.expectedAccountId, result.evidence.observedAt)
        if (Result.isFailure(normalized) && normalized.failure.reason === 'ACCOUNT_BINDING') {
          return Effect.fail(
            new BrokerReadError({
              operation: 'account',
              kind: BrokerReadErrorKind.AccountMismatch,
              message: `Alpaca credential resolved account ${result.value.id}, expected ${runtime.expectedAccountId}`,
              retryable: false,
              status: result.evidence.status,
              requestId: result.evidence.requestId,
              contentHash: result.evidence.contentHash,
              observedAt: result.evidence.observedAt,
              cause: normalized.failure,
            }),
          )
        }
        return normalizeRead('account', result.evidence, normalized)
      }),
    )

    const accountConfiguration = readJson(
      'account-configuration',
      accountConfigurationUrl(),
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

    const positions = readJson('positions', positionsUrl(), decodePositions).pipe(
      Effect.flatMap((result) =>
        normalizeRead(
          'positions',
          result.evidence,
          normalizePositionsResult(result.value, runtime.expectedAccountId, result.evidence.observedAt),
        ),
      ),
    )

    const assetBySymbol = (symbol: string) =>
      decodeInput('asset-by-symbol', decodeAssetSymbol, symbol, 'invalid Alpaca asset symbol').pipe(
        Effect.flatMap((decoded) =>
          readJson('asset-by-symbol', assetBySymbolUrl(decoded), decodeAsset).pipe(
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
          readJson('market-calendar', marketCalendarUrl(decoded), decodeMarketCalendar).pipe(
            Effect.map((result) => ({ decoded, result })),
          ),
        ),
        Effect.flatMap(({ decoded, result }) =>
          normalizeRead('market-calendar', result.evidence, normalizeMarketCalendarResult(result.value, decoded)),
        ),
      )

    const orders = (query: OrdersQuery = {}) =>
      decodeInput('orders', decodeOrdersQuery, query, 'invalid Alpaca orders query').pipe(
        Effect.flatMap((decoded) => readJson('orders', ordersUrl(decoded), decodeOrders)),
        Effect.flatMap((result) =>
          normalizeRead(
            'orders',
            result.evidence,
            normalizeOrdersResult(result.value, runtime.expectedAccountId, result.evidence.observedAt),
          ),
        ),
      )

    const orderById = (orderId: string) =>
      decodeInput('order-by-id', decodeOrderId, orderId, 'invalid Alpaca order ID').pipe(
        Effect.flatMap((decoded) => readJson('order-by-id', orderByIdUrl(decoded), decodeOrder)),
        Effect.flatMap((result) =>
          normalizeRead(
            'order-by-id',
            result.evidence,
            normalizeOrderResult(result.value, runtime.expectedAccountId, result.evidence.observedAt),
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
        Effect.flatMap((decoded) => readJson('order-by-client-id', orderByClientIdUrl(decoded), decodeOrder)),
        Effect.flatMap((result) =>
          normalizeRead(
            'order-by-client-id',
            result.evidence,
            normalizeOrderResult(result.value, runtime.expectedAccountId, result.evidence.observedAt),
          ),
        ),
      )

    const fillActivities = (query: FillActivitiesQuery = {}) =>
      decodeInput('fill-activities', decodeFillActivitiesQuery, query, 'invalid Alpaca fill activities query').pipe(
        Effect.flatMap((decoded) => {
          const request = fillActivitiesRequest(decoded)
          return readJson('fill-activities', request.url, decodeFillActivities).pipe(
            Effect.map((result) => ({ result, pageSize: request.pageSize })),
          )
        }),
        Effect.flatMap(({ pageSize, result }) =>
          Effect.fromResult(normalizeFillActivitiesResult(result.value, runtime.expectedAccountId)).pipe(
            Effect.map((items) => ({
              value: {
                items,
                nextPageToken:
                  items.length === pageSize && items.length > 0 ? items[items.length - 1]?.activityId : undefined,
              },
              evidence: result.evidence,
            })),
            Effect.mapError((cause) =>
              invalidResponse(
                'fill-activities',
                'Alpaca fill-activities response violates the Bayn read contract',
                result.evidence,
                cause,
              ),
            ),
          ),
        ),
      )

    return {
      account,
      accountConfiguration,
      assetBySymbol,
      positions,
      orders,
      orderById,
      orderByClientId,
      fillActivities,
      marketCalendar,
    }
  })
