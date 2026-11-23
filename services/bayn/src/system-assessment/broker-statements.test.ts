import { expect, test } from 'bun:test'
import { ConfigProvider, Effect, Redacted, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { decodeBrokerConnection } from '../broker/connection'
import { BrokerEnvironment, BrokerProvider } from '../broker/identity'
import { BrokerReadErrorKind } from '../broker/alpaca/failures'
import { verifyNonTradeActivityStatement } from '../broker/alpaca/model'
import { JevResearchPolicy } from '../jev/acceptance'
import { captureNativeBrokerStatements } from './broker-statements'

const candidateId = '10000000-0000-4000-8000-000000000001'
const incumbentId = '10000000-0000-4000-8000-000000000002'
const ablationId = '10000000-0000-4000-8000-000000000003'
const candidate = Result.getOrThrow(
  decodeBrokerConnection({
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    baseUrl: 'https://paper-api.alpaca.markets',
    proxyUrl: 'http://bayn-egress-proxy:3128',
    expectedAccountId: candidateId,
    key: Redacted.make('candidate-key'),
    secret: Redacted.make('candidate-secret'),
    operationTimeoutMs: 1_000,
    retryAttempts: 0,
  }),
)
const policies = [
  { policy: JevResearchPolicy.Candidate, riskPolicy: { accountId: candidateId } },
  { policy: JevResearchPolicy.Incumbent, riskPolicy: { accountId: incumbentId } },
  { policy: JevResearchPolicy.Ablation, riskPolicy: { accountId: ablationId } },
] as const
const window = { after: '2026-09-10T13:00:00.000Z', until: '2026-09-11T13:00:00.000Z' }
const credentials = {
  BAYN_QUALIFICATION_INCUMBENT_JEV_ALPACA_KEY_ID: 'incumbent-key',
  BAYN_QUALIFICATION_INCUMBENT_JEV_ALPACA_SECRET_KEY: 'incumbent-secret',
  BAYN_QUALIFICATION_JEV_ABLATION_ALPACA_KEY_ID: 'ablation-key',
  BAYN_QUALIFICATION_JEV_ABLATION_ALPACA_SECRET_KEY: 'ablation-secret',
}
const accounts = new Map([
  ['candidate-key', { id: candidateId, secret: 'candidate-secret', fee: '-0.11' }],
  ['incumbent-key', { id: incumbentId, secret: 'incumbent-secret', fee: '-0.22' }],
  ['ablation-key', { id: ablationId, secret: 'ablation-secret', fee: '-0.33' }],
])

const capture = (environment: Readonly<Record<string, string>>, client: HttpClient.HttpClient) =>
  captureNativeBrokerStatements(candidate, policies, window).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
    Effect.provideService(HttpClient.HttpClient, client),
  )

const broker = (calls: string[]) =>
  HttpClient.make((request, url) => {
    const key = request.headers['apca-api-key-id'] ?? ''
    const account = accounts.get(key)
    if (account === undefined) throw new Error('Unexpected fixture account')
    expect(request.headers['apca-api-secret-key']).toBe(account.secret)
    expect(request.method).toBe('GET')
    expect(url.origin).toBe('https://paper-api.alpaca.markets')
    calls.push(key)
    let body: unknown
    if (url.pathname === '/v2/account') {
      body = {
        id: account.id,
        account_number: '010203ABCD',
        status: 'ACTIVE',
        currency: 'USD',
        cash: '90000.00',
        equity: '90000.00',
        last_equity: '90000.00',
        buying_power: '90000.00',
        account_blocked: false,
        trading_blocked: false,
        trade_suspended_by_user: false,
        options_buying_power: '0',
      }
    } else {
      expect(url.pathname).toBe('/v2/account/activities')
      expect(url.searchParams.get('category')).toBe('non_trade_activity')
      expect(url.searchParams.get('after')).toBe(window.after)
      expect(url.searchParams.get('until')).toBe(window.until)
      body = url.searchParams.has('page_token')
        ? []
        : [
            {
              id: `20260911010000000::${account.id}`,
              activity_type: 'FEE',
              date: '2026-09-10',
              net_amount: account.fee,
              account_id: account.id,
            },
          ]
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json(body, { headers: { 'x-request-id': 'fixture-read' } })),
    )
  })

test('captures independently authenticated activity for the candidate and every registered control', async () => {
  const calls: string[] = []
  const statements = await Effect.runPromise(capture(credentials, broker(calls)))
  expect(statements.size).toBe(3)
  for (const [{ policy, riskPolicy }, fee] of [
    [policies[0], '-0.11'],
    [policies[1], '-0.22'],
    [policies[2], '-0.33'],
  ] as const) {
    const statement = statements.get(policy)
    if (statement === undefined) throw new Error('Missing broker statement')
    const verified = Result.getOrThrow(verifyNonTradeActivityStatement(statement, riskPolicy.accountId))
    expect(verified.activities.map((activity) => activity.netAmount)).toEqual([fee])
    expect(statement.firstPass.at(-1)?.body).toEqual([])
    expect(statement.secondPass.at(-1)?.body).toEqual([])
  }
  expect(calls.sort()).toEqual(
    ['ablation-key', 'candidate-key', 'incumbent-key'].flatMap((key) => Array.from({ length: 5 }, () => key)),
  )
})

test('rejects the candidate credentials when supplied for the registered incumbent', async () => {
  const credentialsWithWrongAccount = {
    ...credentials,
    BAYN_QUALIFICATION_INCUMBENT_JEV_ALPACA_KEY_ID: 'candidate-key',
    BAYN_QUALIFICATION_INCUMBENT_JEV_ALPACA_SECRET_KEY: 'candidate-secret',
  }
  const failure = await Effect.runPromise(capture(credentialsWithWrongAccount, broker([])).pipe(Effect.flip))
  expect(failure).toMatchObject({ operation: 'account', kind: BrokerReadErrorKind.AccountMismatch })
})

test('requires the control credentials before starting a broker read', async () => {
  const calls: string[] = []
  await expect(Effect.runPromise(capture({}, broker(calls)))).rejects.toThrow(
    /BAYN_QUALIFICATION_INCUMBENT_JEV_ALPACA_KEY_ID/,
  )
  expect(calls).toEqual([])
})
