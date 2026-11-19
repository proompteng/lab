import assert from 'node:assert/strict'
import { NodeHttpClient } from '@effect/platform-node'
import * as Undici from '@effect/platform-node/Undici'
import { Effect, Logger, Redacted, Result } from 'effect'

import { readTransportInterceptor, withReadTransportDiagnostics } from '../broker/alpaca/transport-diagnostics'
import { alpacaHttpLayer, make } from '../broker/alpaca/http'
import { alpacaSandboxBaseUrl, decodeBrokerConnection } from '../broker/connection'
import { BrokerEnvironment, BrokerProvider } from '../broker/identity'

const agent = new Undici.MockAgent()
agent.disableNetConnect()
agent.get('https://broker.invalid').intercept({ path: '/private', method: 'GET' }).reply(200, { ok: true })
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan
      const client = yield* NodeHttpClient.makeUndici
      const response = yield* client.get('https://broker.invalid/private').pipe(withReadTransportDiagnostics('account'))
      assert.equal(response.status, 200)
      assert.deepEqual(yield* response.json, { ok: true })
      assert.equal(span.attributes.get('broker.transport.phase'), 'headers_received')
      assert.equal(span.attributes.get('broker.transport.attempts'), 1)
      assert.equal(span.attributes.get('broker.transport.started'), 1)
    }).pipe(
      Effect.withSpan('node-transport'),
      Effect.provideService(NodeHttpClient.Dispatcher, agent.compose(readTransportInterceptor)),
      Effect.provide(Logger.layer([])),
    ),
  )
  agent.assertNoPendingInterceptors()
  const brokerAgent = new Undici.MockAgent()
  brokerAgent.disableNetConnect()
  brokerAgent
    .get(alpacaSandboxBaseUrl)
    .intercept({ path: '/v2/account/configurations', method: 'GET' })
    .reply(200, { fractional_trading: true }, { headers: { 'x-request-id': 'private-request-id' } })
  const connection = Result.getOrThrow(
    decodeBrokerConnection({
      provider: BrokerProvider.Alpaca,
      environment: BrokerEnvironment.Sandbox,
      baseUrl: alpacaSandboxBaseUrl,
      expectedAccountId: 'e6fe16f3-64a4-4921-8928-cadf02f92f98',
      key: Redacted.make('private-key'),
      secret: Redacted.make('private-secret'),
      proxyUrl: 'http://proxy.invalid:3128',
      operationTimeoutMs: 1000,
      retryAttempts: 0,
    }),
  )
  let destroyed = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* make(connection)
        const result = yield* broker.accountConfiguration
        assert.equal(result.value.fractionalTrading, true)
        assert.equal(destroyed, 0)
      }).pipe(
        Effect.provide(
          alpacaHttpLayer(connection, {
            create: () => brokerAgent,
            destroy: async (dispatcher) => {
              destroyed++
              await dispatcher.close()
            },
          }),
        ),
        Effect.provide(Logger.layer([])),
      ),
    ),
  )
  assert.equal(destroyed, 1)
  brokerAgent.assertNoPendingInterceptors()
  process.stdout.write('broker transport node passed\n')
} finally {
  await agent.close()
}
