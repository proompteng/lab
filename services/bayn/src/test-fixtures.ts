import { buildInputManifest } from './market-data'
import { defaultProtocol } from './protocol'
import type { DailyBar, InputManifest, IsoDate } from './types'

export const makeBars = (sessionCount = 900): readonly DailyBar[] => {
  const bars: DailyBar[] = []
  const cursor = new Date('2018-01-02T00:00:00Z')
  let session = 0
  while (session < sessionCount) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) {
      for (let symbolIndex = 0; symbolIndex < defaultProtocol.universe.length; symbolIndex += 1) {
        const symbol = defaultProtocol.universe[symbolIndex]
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
    manifest: buildInputManifest(bars, 'signal', 'adjusted_daily_bars_v1', defaultProtocol.universe, 'fixture-v1'),
  }
}
