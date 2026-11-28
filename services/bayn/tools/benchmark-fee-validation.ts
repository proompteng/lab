import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Result } from 'effect'

import { cryptoMaximumTakerFeeBps } from '../src/broker/crypto-fees'
import { jevEntryEconomics } from '../src/jev/entry-economics'
import { defaultJevProtocolDocument } from '../src/jev/protocol'
import { calculateSessionFees, equityTafRate } from '../src/strategy/execution-model/fees'
import { intradayExecutionModel } from '../src/strategy/intraday-market'

const serialize = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? String(item) : item))
const dates = [
  '2026-09-30',
  '2026-10-01T04:00:00.000Z',
  '2027-01-01T04:59:59.000Z',
  '2027-01-01T05:00:00.000Z',
  '2026-09-31',
  'invalid',
]
const digest = createHash('sha256')
for (const at of dates) digest.update(serialize(equityTafRate(intradayExecutionModel, at)))

const cases: Readonly<Record<string, () => Result.Result<unknown, unknown>>> = {
  fee: () =>
    calculateSessionFees(
      [{ symbol: 'NVDA', side: 'sell', quantityAtoms: 100_000_000_000n, notionalMicros: 10_000_000_000n }],
      intradayExecutionModel,
      1_000_000n,
      cryptoMaximumTakerFeeBps,
      '2026-09-04T14:15:00.000Z',
    ),
  entry: () =>
    jevEntryEconomics({
      feeAt: '2026-09-04T14:15:00.000Z',
      protocol: defaultJevProtocolDocument,
      symbol: 'NVDA',
      bidMicros: 100_000_000n,
      askMicros: 100_010_000n,
      capitalMicros: '100000000000',
      cryptoFeeTier: null,
    }),
}
for (const [name, run] of Object.entries(cases)) {
  digest.update(serialize(Result.getOrThrow(run())))
  for (let i = 0; i < 1000; i++) Result.getOrThrow(run())
  const samples = []
  const iterations = name === 'fee' ? 10_000 : 1000
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) Result.getOrThrow(run())
    samples.push(((performance.now() - start) * 1000) / iterations)
  }
  samples.sort((a, b) => a - b)
  console.log(serialize({ name, iterations, microsecondsPerCall: samples }))
}
console.log(`outputSha256=${digest.digest('hex')}`)
