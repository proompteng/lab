import { Effect } from 'effect'

import { makeRuntimeProvenance, type RuntimeProvenance } from './contracts'
import { buildInputManifest } from './market-data'
import { hashTsmomParameters, loadDefaultProtocol } from './protocol'
import type { DailyBar, InputManifest, IsoDate, TsmomProtocol } from './types'

export const fixtureProtocol = Effect.runSync(loadDefaultProtocol)

export const makeTestProvenance = (
  protocol: TsmomProtocol = fixtureProtocol,
  overrides: {
    readonly sourceRevision?: string
    readonly imageDigest?: string
    readonly behaviorHash?: string
  } = {},
): RuntimeProvenance =>
  makeRuntimeProvenance({
    sourceRevision: overrides.sourceRevision ?? 'a'.repeat(40),
    image: {
      repository: 'registry.ide-newton.ts.net/lab/bayn',
      digest: overrides.imageDigest ?? `sha256:${'b'.repeat(64)}`,
    },
    strategy: {
      name: 'tsmom',
      behaviorHash: overrides.behaviorHash ?? 'c'.repeat(64),
      parameterHash: hashTsmomParameters(protocol),
      parameterSchemaVersion: protocol.schemaVersion,
    },
  })

export const makeBars = (sessionCount = 900): readonly DailyBar[] => {
  const bars: DailyBar[] = []
  const cursor = new Date('2018-01-02T00:00:00Z')
  let session = 0
  while (session < sessionCount) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) {
      for (let symbolIndex = 0; symbolIndex < fixtureProtocol.universe.length; symbolIndex += 1) {
        const symbol = fixtureProtocol.universe[symbolIndex]
        const trend = symbolIndex % 3 === 0 ? -0.00005 : 0.00025 + symbolIndex * 0.00001
        const close =
          (50 + symbolIndex * 10) * (1 + trend * session) * (1 + 0.025 * Math.sin(session / 18 + symbolIndex))
        const open = close * (1 + 0.002 * Math.sin(session / 7 + symbolIndex))
        bars.push({
          symbol,
          sessionDate: cursor.toISOString().slice(0, 10) as IsoDate,
          open,
          high: Math.max(open, close) * 1.003,
          low: Math.min(open, close) * 0.997,
          close,
          volume: 1_000_000 + session * 10 + symbolIndex,
          source: 'fixture',
          sourceFeed: 'test',
          adjustment: 'all',
          datasetVersion: 'fixture-v1',
        })
      }
      session += 1
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return bars
}

export const makeSnapshot = (
  sessionCount = 900,
): { readonly bars: readonly DailyBar[]; readonly manifest: InputManifest } => {
  const bars = makeBars(sessionCount)
  return {
    bars,
    manifest: buildInputManifest(bars, 'signal', 'adjusted_daily_bars_v1', fixtureProtocol.universe, 'fixture-v1'),
  }
}
