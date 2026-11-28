// Universe and champion IDs are taken from the frozen Wave 3B ref, not from either export's manifest.
export const stocks = (
  'NVDA AMD MU AVGO COHR LITE MRVL WDC SNDK TSLA META GOOGL MSFT AAPL AMZN INTC NFLX PLTR MSTR COIN SMCI ARM ANET ' +
  'PANW CRWD NET APP HOOD SOFI VRT VST CEG GEV ALAB CRDO KLAC LRCX AMAT ASML TSM ORCL NOW SNOW UBER SHOP SPOT'
)
  .split(' ')
  .sort()
export const universe = [
  ...stocks,
  ...'SPY QQQ SMH IWM XLF XLE XLK XLV XLI XLY XBI ARKK TLT IEF GLD USO'.split(' '),
].sort()
export const baselineNames =
  'AAPL AMD AMZN AVGO COHR GOOGL INTC IWM LITE META MRVL MSFT MU NFLX NVDA SNDK TSLA WDC'.split(' ')
export const noiseNames = ['QQQ', 'SMH'] as const
export const benchmark = 'SPY'
export const evidence = 'docs/bayn/evidence/2026-11-27-8yr-unseen-intraday-oos'
export const protocolFile = `${evidence}/protocol.md`
export const protocolSource = 'services/bayn/tools/8yr-unseen-intraday-protocol.ts'

const blindPrefix = 'bayn-research-datasets/2026-11-27-sip-8yr-5m-unseen'
const priorPrefix = 'bayn-research-datasets/2026-11-27-sip-multiyear'
export const blind = {
  first: '2016-01-04',
  last: '2023-12-29',
  sessions: 2012,
  manifest: `${blindPrefix}/MANIFEST.json`,
  calendar: `${blindPrefix}/calendar_2016_2023.json`,
  bars: `${blindPrefix}/alpaca_sip_5m_rth_62sym_20160104_20231229.tsv.gz`,
  manifestSha256: 'a0ccd4388d6eb8a2c6dcfe8ba85fa2c0aead12c0a2017ad37487c2745d33e7e8',
  calendarSha256: '0165400d9544973b0971a2397969e65bd2543beff5d8bd47510f09b015ef7f86',
  rows: 9_774_322,
} as const
export const prior = {
  first: '2024-01-02',
  last: '2026-11-25',
  sessions: 729,
  manifest: `${priorPrefix}/MANIFEST.json`,
  calendar: 'bayn-research-datasets/2026-11-27/calendar_2024_2026.json',
  bars: `${priorPrefix}/alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz`,
  manifestSha256: '5df0cfe213c69e9a6489dde46553db610edb2632b5e54fb76a6347740abcdead',
  calendarSha256: 'b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71',
  rows: 3_923_737,
} as const

// First regular-way trading dates for names whose current security cannot be
// identified merely by finding a ticker in the tape. Start with no synthetic history.
export const listingDates: Readonly<Record<string, string>> = {
  ALAB: '2024-03-20',
  APP: '2021-04-15',
  ARM: '2023-09-14',
  CEG: '2022-02-02',
  COIN: '2021-04-14',
  CRDO: '2022-01-27',
  CRWD: '2019-06-12',
  GEV: '2024-04-02',
  HOOD: '2021-07-29',
  NET: '2019-09-13',
  PLTR: '2020-09-30',
  SMCI: '2007-03-29',
  SNDK: '2025-02-24',
  SNOW: '2020-09-16',
  SOFI: '2021-06-01',
  SPOT: '2018-04-03',
  UBER: '2019-05-10',
  VRT: '2020-02-10',
  VST: '2017-05-10',
}

export const parameters = {
  historySessions: 14,
  barMinutes: 5,
  costsRtBps: [2, 5, 10],
  sellFeeBps: 0.21,
  equityUsd: 100_000,
  grossCapUsd: 180_000,
  standaloneSymbolCapUsd: 60_000,
  historyResets: { WDC: '2025-02-24' },
  listingSuspensions: { SMCI: ['2018-08-23', '2020-01-14'] },
  reversion: { decisionMinuteFromOpen: 150, pairs: 2, stopBps: 500, targetBps: 800, flattenBeforeCloseMinutes: 5 },
  orb: {
    rangeMinutes: 5,
    rvol: 2.5,
    gapAtr: 0.5,
    riskUsd: 1000,
    hardExitMinuteFromOpen: 118,
    shortDayFlattenBeforeCloseMinutes: 25,
  },
  noise: {
    checkpointMinutes: 30,
    lastCheckpointMinuteFromOpen: 330,
    band: 1.2,
    riskUsd: 1500,
    flattenBeforeCloseMinutes: 2,
  },
  baseline: {
    rangeMinutes: 15,
    orbDecisionMinutesFromOpen: [30, 80],
    orbRiskUsd: 500,
    orbCapUsd: 35_000,
    orbStopAtr: 0.35,
    orbStopBoundsBps: [50, 300],
    orbTargetR: 2,
    orbHoldMinutes: 60,
    reversionDecisionMinutesFromOpen: [120, 150],
    reversionCapPerLegUsd: 18_000,
    noiseBand: 1,
    noiseStopAtr: 1.5,
    noiseStopBoundsBps: [150, 600],
    noiseTargetBps: 1500,
    noiseSleeveGrossUsd: 50_000,
    noiseWeightBounds: [0.15, 0.32],
  },
  bootstrap: { draws: 10_000, meanBlockSessions: 5, seed: 0x27f22fed },
  megaCaps: ['AAPL', 'AMZN', 'GOOGL', 'META', 'MSFT', 'NVDA', 'QQQ', 'SMH'],
  recentEntryFrom: '2019-01-01',
} as const

export const roster = {
  C1: { engine: 'baseline' },
  C2: { engine: 'orb', top: 1, targetR: 2 },
  C3_3R: { engine: 'orb', top: 1, targetR: 3 },
  C3_top2: { engine: 'orb', top: 2, targetR: 2 },
  C4_timed: { engine: 'reversion', iqrBps: 100, exit: 'timed' },
  C4_brackets: { engine: 'reversion', iqrBps: 100, exit: 'brackets' },
  C4_ungated: { engine: 'reversion', iqrBps: 0, exit: 'brackets' },
  C5: { engine: 'noise' },
  C6: { engine: 'portfolio', sleeves: ['C2', 'C4_timed'], weights: [0.75, 0.25] },
  C7_equal: { engine: 'portfolio', sleeves: ['C2', 'C4_timed', 'C5'], weights: [1 / 3, 1 / 3, 1 / 3] },
  C7_tilt: { engine: 'portfolio', sleeves: ['C2', 'C4_timed', 'C5'], weights: [0.5, 0.25, 0.25] },
} as const
