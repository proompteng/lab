import { expect, test } from 'bun:test'

import { receipts } from './pure-etf-dual-horizon-data'
import { verifyBaseManifest } from './research-10yr-vol-parity-switch'
import {
  assets,
  clearsRebalanceBand,
  closeSignals,
  markTape,
  nextRegime,
  Regime,
  replay,
  type TapeDay,
  targetWeights,
  verdictFor,
  Verdict,
} from './research-10yr-vol-parity-switch-core'

const manifest = (etfs: readonly string[]) => {
  const tape = receipts.datasets.daily
  return {
    schemaVersion: 'bayn.sip-10yr-sp100-manifest.v1',
    source: 'Alpaca Market Data API v2 (feed=sip, adjustment=all [split+dividend total return])',
    etfs,
    files: [
      {
        key: `${tape.prefix}/${tape.name}`,
        rows: tape.rows,
        gzipBytes: tape.bytes,
        gzipSha256: tape.sha256,
        rawBytes: tape.rawBytes,
        rawSha256: tape.rawSha256,
      },
    ],
  }
}

test('requires six unique base-tape listings and a matching total-return tape receipt', () => {
  expect(verifyBaseManifest(manifest([...assets, 'IWM'])).symbols).toEqual(assets)
  expect(() => verifyBaseManifest(manifest([...assets.filter((asset) => asset !== 'GLD'), 'SLV']))).toThrow(
    'Base SIP manifest must uniquely list all six registered candidate assets',
  )
  expect(() => verifyBaseManifest(manifest([...assets, 'GLD']))).toThrow('uniquely list')
  expect(() => verifyBaseManifest({ ...manifest(assets), source: 'IEX' })).toThrow()
  const { files } = manifest(assets)
  expect(() => verifyBaseManifest({ ...manifest(assets), files: [{ ...files[0], rows: 0 }] })).toThrow()
})

test('fails closed on missing marks and non-increasing sessions', () => {
  const first = { date: '2020-03-16', bars: new Map() }
  const second = { date: '2020-03-17', bars: new Map() }
  expect(() => markTape([first, second])).toThrow('Missing or invalid SPY price on 2020-03-16')
  expect(() => markTape([second, first])).toThrow('Duplicate or out-of-order')
  expect(() => markTape([first, first])).toThrow('Duplicate or out-of-order')
})

test('hysteresis holds either state in the interior and switches at the inclusive boundaries', () => {
  expect(nextRegime(Regime.Calm, 0.199)).toBe(Regime.Calm)
  expect(nextRegime(Regime.Calm, 0.2)).toBe(Regime.Stress)
  expect(nextRegime(Regime.Stress, 0.151)).toBe(Regime.Stress)
  expect(nextRegime(Regime.Stress, 0.15)).toBe(Regime.Calm)
  expect(() => nextRegime(Regime.Calm, NaN)).toThrow('Invalid SPY realized volatility')
})

test('parity equalizes the two basket exposures to volatility inside each funded regime', () => {
  const calm = targetWeights(Regime.Calm, 0.3, 0.1)
  const stress = targetWeights(Regime.Stress, 0.3, 0.1)
  for (const weights of [calm, stress]) {
    expect(Object.values(weights).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 14)
    expect(weights.SPY).toBe(weights.QQQ)
    expect(weights.TLT).toBe(weights.IEF)
    expect((weights.SPY + weights.QQQ) * 0.3).toBeCloseTo((weights.TLT + weights.IEF) * 0.1, 14)
  }
  expect(stress.SHY).toBe(0.45)
  expect(stress.GLD).toBe(0.15)
  expect(calm.SHY).toBe(0.05)
  expect(calm.GLD).toBe(0.05)
  expect(() => targetWeights(Regime.Calm, 0, 0.1)).toThrow('positive, finite basket volatility')
  expect(clearsRebalanceBand([0, 0.03], [0.015, 0.015])).toBe(false)
  expect(clearsRebalanceBand([0, 0.02], [0.02, 0])).toBe(true)
  expect(clearsRebalanceBand([0.02, 0], [0, 0])).toBe(true)
})

const marks = (overnight: number, intraday: number) => ({ overnight, intraday, closeReturn: overnight * intraday - 1 })
// Ratios derived from 2020-03-13..18 in the digest-verified base tape; no fabricated price or return path.
const observed: readonly TapeDay[] = [
  {
    date: '2020-03-16',
    marks: {
      SPY: marks(0.8925794765335613, 0.9995439620576432),
      QQQ: marks(0.9054076042740142, 0.9721440124603127),
      TLT: marks(1.0417698266911588, 1.022002453235204),
      IEF: marks(1.0228513650151667, 1.0034598655595097),
      SHY: marks(1.0035326086956522, 0.9981045220687788),
      GLD: marks(0.9594085646533688, 1),
    },
  },
  {
    date: '2020-03-17',
    marks: {
      SPY: marks(1.0164704808832923, 1.0373445845863818),
      QQQ: marks(1.0364185358639388, 1.0380522028658066),
      TLT: marks(0.9975245667991898, 0.9356294179575877),
      IEF: marks(0.995566939217811, 0.9793192163071442),
      SHY: marks(1.0008138903960933, 0.9968826240173488),
      GLD: marks(1.0190462343704565, 1.0261092880582108),
    },
  },
  {
    date: '2020-03-18',
    marks: {
      SPY: marks(0.9294275453247371, 0.9976256983240223),
      QQQ: marks(0.9421501804227047, 1.0291203112651224),
      TLT: marks(0.9991158977656326, 0.9444936046979325),
      IEF: marks(0.9929271496413055, 0.9930802889996948),
      SHY: marks(1.0004078857919783, 0.9983691220440336),
      GLD: marks(0.9854699666295884, 0.9925220458553792),
    },
  },
]

test('keeps actual early observations flat when there is insufficient close history', () => {
  expect(replay(observed, closeSignals(observed), 10).map(({ net, signalDate }) => ({ net, signalDate }))).toEqual(
    observed.map(() => ({ net: 0, signalDate: null })),
  )
})

test('rolls old holdings through the following open before funding the new portfolio', () => {
  // Supply two close decisions to test execution independently of the 21-session signal warm-up.
  const first = { date: observed[0].date, regime: Regime.Calm, equityVol: 0.3, bondVol: 0.1 }
  const second = { ...first, date: observed[1].date, regime: Regime.Stress }
  const result = replay(observed, [first, second, undefined], 10)
  expect(result[0].net).toBe(0)
  expect(result[0].rebalanced).toBe(false)
  expect(result[1].signalDate).toBe(first.date)
  expect(result[1].regime).toBe(Regime.Calm)
  expect(result[2].signalDate).toBe(second.date)
  expect(result[2].regime).toBe(Regime.Stress)
  expect(result[2].rebalanced).toBe(true)
  expect(result.slice(0, 2)).toEqual(
    replay(observed, [first, { ...second, regime: Regime.Calm }, undefined], 10).slice(0, 2),
  )
  expect(() => replay(observed, [second, undefined, undefined], 10)).toThrow('Signal not dated on the prior session')

  const perSide = 5 / 10_000
  const sellFee = 0.21 / 10_000
  const firstWeights = [0.1125, 0.1125, 0.3375, 0.3375, 0.05, 0.05]
  const secondWeights = [0.05, 0.05, 0.15, 0.15, 0.45, 0.15]
  const firstClose = assets.map((asset, i) => (firstWeights[i] * observed[1].marks[asset].intraday) / (1 + perSide))
  const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0)
  const firstNav = total(firstClose)
  expect(result[1].net).toBeCloseTo(firstNav - 1, 13)
  expect(result[1].turnover).toBeCloseTo(0.5 / (1 + perSide), 13)
  const carried = assets.map((asset, i) => firstClose[i] * observed[2].marks[asset].overnight)
  const sells = total(carried.slice(0, 4))
  const buys = total(carried.slice(4))
  // For this observed transition the risk legs are all sells and the reserve legs are all buys.
  const afterFees =
    (total(carried) - (perSide + sellFee) * sells + perSide * buys) / (1 - (perSide + sellFee) * 0.4 + perSide * 0.6)
  const secondNav = afterFees * total(assets.map((asset, i) => secondWeights[i] * observed[2].marks[asset].intraday))
  expect(result[2].net).toBeCloseTo(secondNav / firstNav - 1, 13)
  expect(result[2].fees).toBeCloseTo(1 - afterFees / total(carried), 13)
  expect(replay(observed, [first, second, undefined], 0)[2].fees).toBeGreaterThan(0)
})

test('promotion requires one complete route across all nonzero costs', () => {
  const alpha = { alpha: true, diversification: false }
  const blend = { alpha: false, diversification: true }
  expect(
    verdictFor(
      new Map([
        [2, alpha],
        [5, alpha],
        [10, alpha],
      ]),
    ),
  ).toBe(Verdict.Promote)
  expect(
    verdictFor(
      new Map([
        [2, blend],
        [5, blend],
        [10, blend],
      ]),
    ),
  ).toBe(Verdict.Promote)
  expect(
    verdictFor(
      new Map([
        [0, alpha],
        [2, alpha],
        [5, alpha],
      ]),
    ),
  ).toBe(Verdict.DoNotPromote)
  expect(
    verdictFor(
      new Map([
        [2, alpha],
        [5, blend],
        [10, alpha],
      ]),
    ),
  ).toBe(Verdict.DoNotPromote)
  expect(verdictFor(new Map())).toBe(Verdict.DoNotPromote)
})
