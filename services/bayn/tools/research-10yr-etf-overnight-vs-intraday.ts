import { lstatSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect } from 'effect'

import { dailySharpe, expectedMaximumSharpe } from './midday-research-statistics'
import { loadDevelopment, loadHoldout, sources as noiseSources, withArchive } from './noise-area-study-data'
import {
  baskets,
  capital,
  costs,
  createReplay,
  netAt,
  prepare,
  splits,
  type Day,
  type Prepared,
  type Trial,
} from './noise-area-study-replay'
import { comparisonReport, decomposition, sellFee, type LedgerDay } from './overnight-etf-statistics'
import {
  assets,
  developmentEnd,
  end,
  hash,
  loadSessions,
  sources as dailySources,
  universe,
} from './vol-regime-carry-data'
import type { Session, Symbol } from './vol-regime-carry-data'
import { idleTarget, openingTrade, shouldTrade } from './vol-regime-carry-replay'
import { signalModel, trendSeries, weights } from './vol-regime-carry-signals'

const evidence = 'docs/bayn/evidence/2026-11-27-10yr-etf-overnight-vs-intraday'
const protocolPath = evidence + '/protocol.md'
const freezePath = evidence + '/freeze.json'
const branch = 'refs/heads/codex/bayn-w9a-10yr-etf-overnight-vs-intraday'
const locked = [
  protocolPath,
  'bun.lock',
  ...[
    'research-10yr-etf-overnight-vs-intraday',
    'research-10yr-etf-overnight-vs-intraday.test',
    'overnight-etf-statistics',
    'noise-area-study-data',
    'noise-area-study-replay',
    'noise-area-study-statistics',
    'midday-research-statistics',
    'research-orb-zab-data',
    'vol-regime-carry-data',
    'vol-regime-carry-replay',
    'vol-regime-carry-signals',
  ].map((name) => `services/bayn/tools/${name}.ts`),
]
export const tiers = [0, ...costs] as const
export const b0: Trial = {
  id: 'B0/30/1.4/opposite_band/inverse_vol_parity',
  basket: 'B0',
  minutes: 30,
  band: 1.4,
  exit: 'opposite_band',
  sizing: 'inverse_vol_parity',
}
const f2 = { family: 'F2', cadence: 42, credit: 'IEF', ema: 100, smooth: 10 } as const
const f4 = { family: 'F4', cadence: 42, power: 1, credit: 'LQD', mix: 'parity' } as const
const allocation = (target: Partial<Record<Symbol, number>>) => universe.map((symbol) => target[symbol] ?? 0)
const shy = allocation({ SHY: 1 })
const risk = allocation({ SPY: 1 / 3, QQQ: 1 / 3, SMH: 1 / 3 })
const haven = allocation({ SHY: 1 / 3, IEF: 1 / 3, GLD: 1 / 3 })
const cash = weights()
export const mark = (session: Session, symbol: Symbol, field: 'open' | 'close') => {
  const value = session.bars[assets[symbol]]?.[field]
  if (value === undefined) throw new Error(`Missing ${field} mark: ${symbol} ${session.date}`)
  return value
}
const average = (values: readonly number[], index: number, lookback: number) =>
  values.slice(index + 1 - lookback, index + 1).reduce((total, value) => total + value, 0) / lookback

// Indexed by the session at whose CLOSE the order executes, not by the session of its opening exit.
export const gateAtClose = (sessions: readonly Session[]) => {
  const spy = sessions.map((session) => mark(session, 'SPY', 'close'))
  const credit = trendSeries(
    sessions.map((session) => mark(session, 'HYG', 'close') / mark(session, 'IEF', 'close')),
    100,
  )
  return sessions.map((_, t) => {
    const known = t - 1
    if (known < 199) return shy
    const slow = average(spy, known, 200)
    return (credit[known] ?? 0) > 0 && spy[known] > slow && average(spy, known, 50) > slow ? risk : haven
  })
}

type Targets = readonly (number[] | undefined)[]
interface Book {
  readonly id: string
  readonly initial?: number[]
  readonly close?: Targets
  readonly open?: Targets
  readonly daytime?: number[]
  readonly noise?: 'reference' | 'continuous' | 'cash'
}

export const books = (sessions: readonly Session[]): Book[] => {
  const gate = gateAtClose(sessions)
  const wave5c = signalModel(sessions)
  const f2Targets = wave5c(f2)
  const f4Targets = wave5c(f4)
  const overnight = [
    ['SPY', allocation({ SPY: 1 })],
    ['QQQ', allocation({ QQQ: 1 })],
    ['SMH', allocation({ SMH: 1 })],
    ['60-40', allocation({ SPY: 0.6, TLT: 0.4 })],
  ] as const
  return [
    { id: 'C0-SHY', initial: shy },
    { id: 'C1-SPY', initial: allocation({ SPY: 1 }) },
    ...overnight.flatMap(([name, target]) =>
      (
        [
          ['cash', cash],
          ['SHY', shy],
        ] as const
      ).map(([idle, daytime]) => ({
        id: `C2-${name}-${idle}`,
        close: sessions.map(() => target),
        daytime,
      })),
    ),
    { id: 'C3-cash', close: gate, daytime: cash },
    { id: 'C3-SHY', close: gate, daytime: shy },
    { id: 'C3-continuous', initial: shy, close: gate },
    { id: 'F2', initial: shy, open: f2Targets },
    { id: 'F4', initial: shy, open: f4Targets },
    { id: 'C4-F2-B0', initial: shy, open: f2Targets, noise: 'continuous' },
    { id: 'C4-F4-B0', initial: shy, open: f4Targets, noise: 'continuous' },
    { id: 'C5-C3-B0', close: gate, daytime: cash, noise: 'cash' },
    { id: 'B0', noise: 'reference' },
  ]
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)
const etfTrade = (
  shares: number[],
  cashUsd: number,
  session: Session,
  field: 'open' | 'close',
  target: number[] | undefined,
  bp: number,
) => {
  const current = shares.map((quantity, i) => (quantity === 0 ? 0 : quantity * mark(session, universe[i], field)))
  const equity = sum(current) + cashUsd
  if (target === undefined) return { shares, cash: cashUsd, equity, notional: 0, fees: 0, invested: sum(current) }

  // Wave 5C's self-financing solver includes the sell fee, including when its slippage bps are zero.
  // At Wave 9A's gross tier all expenses are explicitly disabled.
  const trade =
    bp === 0
      ? { invested: target.map((weight) => weight * equity), cash: equity * Math.max(0, 1 - sum(target)) }
      : openingTrade(current, equity, target, bp)
  const invested = sum(trade.invested)
  return {
    shares: trade.invested.map((value, i) => (value === 0 ? 0 : value / mark(session, universe[i], field))),
    cash: trade.cash,
    equity: invested + trade.cash,
    notional: sum(current.map((value, i) => Math.abs(value - trade.invested[i]))),
    fees: equity - invested - trade.cash,
    invested,
  }
}

export const settleNoise = (
  day: Prepared,
  budget: number,
  blocked: (symbol: (typeof baskets.B0)[number]) => boolean,
  bp: number,
  replay = createReplay(day),
) => {
  let gross = 0
  let fees = 0
  let notional = 0
  let reserved = 0
  let stressedCash = 0
  let blockedEntries = 0
  let earliestEntry = day.slots
  let latestExit = 0
  const slip = bp / 20_000
  const ledger = replay(b0, baskets.B0, undefined, {
    budget,
    blocked: (symbol) => (symbol === 'QQQ' || symbol === 'SMH') && blocked(symbol),
    onBlocked: () => blockedEntries++,
    onFill: ({ side, quantity, entry, exit, entrySlot, exitSlot, maxHigh }) => {
      if (entrySlot < 6 || exitSlot <= entrySlot || exitSlot > day.slots - 1)
        throw new Error(`B0 clock violation: ${day.date} slots ${entrySlot}–${exitSlot}`)
      const sold = side === 1 ? exit : entry
      const tradeFee = quantity * ((entry + exit) * slip + sold * (1 - slip) * (bp > 0 ? sellFee : 0))
      gross += quantity * side * (exit - entry)
      notional += quantity * (entry + exit)
      fees += tradeFee
      reserved += quantity * entry * (1 + Math.max(...costs) / 20_000)
      stressedCash += quantity * (side === 1 ? entry : Math.max(0, maxHigh - entry)) + tradeFee
      earliestEntry = Math.min(earliestEntry, entrySlot)
      latestExit = Math.max(latestExit, exitSlot)
    },
  })
  const net = gross - fees
  if (ledger.unresolved > 0) throw new Error(`Unresolved executed B0 exit on ${day.date}`)
  if (bp > 0 && Math.abs(net - Number(netAt(ledger, bp))) > 1e-8)
    throw new Error(`B0 ledger does not reconcile: ${day.date}`)
  if (reserved > budget + 1e-8) throw new Error(`B0 reservation exceeds budget: ${day.date}`)
  return {
    net,
    fees,
    notional,
    reserved,
    stressedCash,
    blockedEntries,
    firstEntryMinutesAfterOpen: ledger.trades === 0 ? null : 5 * earliestEntry,
    lastExitMinutesBeforeClose: ledger.trades === 0 ? null : 5 * (day.slots - latestExit),
    trades: ledger.trades,
    missingEntries: ledger.missingEntries,
    missingHeld: ledger.missingHeld,
    peakNoiseGross: ledger.grossUpperBound,
  }
}

export const replayBook = (sessions: readonly Session[], tape: readonly Prepared[], book: Book, bp: number) => {
  let shares = weights()
  let cashUsd = capital
  let equity = capital
  return sessions.map((session, i): LedgerDay => {
    const prev = sessions[i - 1]
    const closeTarget = book.close?.[i - 1]
    const closeOrder = etfTrade(
      shares,
      cashUsd,
      prev ?? session,
      prev === undefined ? 'open' : 'close',
      closeTarget,
      bp,
    )
    const openMark = etfTrade(closeOrder.shares, closeOrder.cash, session, 'open', undefined, bp)
    const openTarget = i === 0 ? (book.daytime ?? book.initial) : book.daytime
    const signal = book.open?.[i - 1]
    const priorWeights = closeOrder.shares.map((quantity, j) =>
      quantity === 0
        ? 0
        : (quantity * mark(prev ?? session, universe[j], prev === undefined ? 'open' : 'close')) / equity,
    )
    const target = signal === undefined ? openTarget : idleTarget(signal)
    const opening = etfTrade(
      closeOrder.shares,
      closeOrder.cash,
      session,
      'open',
      signal === undefined || (target !== undefined && shouldTrade(priorWeights, target)) ? target : undefined,
      bp,
    )
    const closing = etfTrade(opening.shares, opening.cash, session, 'close', undefined, bp)
    const day = tape[i]
    if (day?.date !== session.date) throw new Error(`Daily/intraday calendar discrepancy on ${session.date}`)
    const cap = Math.max(0, 2 * Math.min(equity, openMark.equity, opening.equity))
    const reservedCore = Math.max(closeOrder.invested, openMark.invested, opening.invested)
    const capacity = Math.max(0, cap - reservedCore)
    const budget =
      book.noise === 'reference'
        ? capital
        : Math.min(capital, capacity, book.noise === 'cash' ? opening.cash : Infinity)
    if (book.noise === 'cash' && opening.invested !== 0)
      throw new Error(`C5 ETF book not flat at open: ${session.date}`)
    const noise =
      book.noise === undefined
        ? undefined
        : settleNoise(day, budget, (symbol) => opening.shares[assets[symbol]] !== 0, bp)
    const cashAfterNoise = closing.cash + (noise?.net ?? 0)
    // Intraday borrowing is allowed in C4, but no debit may survive the close.
    const sellRate = bp > 0 ? bp / 20_000 + sellFee : 0
    const fundingSale = book.noise === 'continuous' ? Math.max(0, -cashAfterNoise) / (1 - sellRate) : 0
    const fundingFee = fundingSale * sellRate
    const closeCash = fundingSale > 0 ? 0 : cashAfterNoise
    const closeEquity = closing.invested - fundingSale + closeCash
    if (!(closeEquity > 0) || opening.cash < 0 || closeCash < 0 || fundingSale > closing.invested)
      throw new Error(`Nonpositive NAV or ETF financing debit for ${book.id} on ${session.date}`)
    const boundary = i > 0 && book.daytime !== undefined ? opening.equity : openMark.equity
    const row = {
      date: session.date,
      net: closeEquity / equity - 1,
      overnight: boundary / equity - 1,
      intraday: closeEquity / boundary - 1,
      nav: closeEquity,
      priorNav: equity,
      fees: closeOrder.fees + opening.fees + (noise?.fees ?? 0) + fundingFee,
      mocNotional: closeOrder.notional,
      fundingNotional: fundingSale,
      openNotional: opening.notional,
      noiseNotional: noise?.notional ?? 0,
      noiseNet: noise?.net ?? 0,
      overnightGrossRatio: i === 0 ? 0 : closeOrder.invested / closeOrder.equity,
      intradayEntryGrossRatio: (opening.invested + (noise?.reserved ?? 0)) / opening.equity,
      intradayMarkWarning:
        noise !== undefined &&
        noise.trades > 0 &&
        Math.max(reservedCore, closing.invested) + noise.peakNoiseGross > cap + 1e-8,
      cashStressShortfall: book.noise === 'cash' ? Math.max(0, (noise?.stressedCash ?? 0) - opening.cash) : 0,
      noise,
      spyDay: mark(session, 'SPY', 'close') / mark(session, 'SPY', 'open') - 1,
    }
    shares =
      fundingSale > 0
        ? closing.shares.map((quantity) => quantity * (1 - fundingSale / closing.invested))
        : closing.shares
    cashUsd = closeCash
    equity = closeEquity
    return row
  })
}

const buildLedgers = (sessions: readonly Session[], intraday: readonly Day[]) => {
  if (sessions.length !== intraday.length) throw new Error('Mismatched daily and intraday session counts')
  const tape = [...prepare(intraday)]
  const configured = books(sessions)
  return tiers.map((bp) => ({
    bp,
    books: configured.map((book) => ({ id: book.id, rows: replayBook(sessions, tape, book, bp) })),
  }))
}

export const afterFreeze = <A>(computed: string, published: string, load: () => Promise<A>) => {
  if (computed !== published) throw new Error('Development ledger does not reproduce the published freeze')
  return load()
}

const serialize = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const git = (...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
  if (!result.success) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}
const lock = () => {
  git('ls-files', '--error-unmatch', '--', ...locked)
  git('diff', 'HEAD', '--exit-code', '--', ...locked)
  const protocolCommit = git('log', '-1', '--format=%H', 'HEAD', '--', protocolPath).trim()
  const remote = git('ls-remote', '--refs', 'origin', branch).trim().split('\t')
  if (!/^[a-f0-9]{40}$/.test(protocolCommit) || remote[1] !== branch)
    throw new Error('Publish the protocol on the registered branch before development')
  return { protocolCommit, remoteRevision: remote[0] }
}
const verifyPublished = (stage: '--develop' | '--score') => {
  const { protocolCommit, remoteRevision } = lock()
  git('merge-base', '--is-ancestor', protocolCommit, remoteRevision)
  git('diff', protocolCommit, 'HEAD', '--exit-code', '--', protocolPath)
  const files = Object.fromEntries(locked.map((path) => [path, hash(git('show', `HEAD:${path}`))]))
  if (stage === '--develop') {
    // A post-study development reproduction may run from a later commit with the same locked files.
    git('diff', remoteRevision, 'HEAD', '--exit-code', '--', ...locked)
    return { protocolCommit, files, publication: undefined }
  }
  const freezeCommit = git('log', '--diff-filter=A', '-1', '--format=%H', 'HEAD', '--', freezePath).trim()
  if (!/^[a-f0-9]{40}$/.test(freezeCommit) || freezeCommit === protocolCommit)
    throw new Error('Commit and publish the development freeze before Holdout')
  git('merge-base', '--is-ancestor', freezeCommit, remoteRevision)
  git('diff', freezeCommit, 'HEAD', '--exit-code', '--', freezePath, ...locked)
  git('diff', 'HEAD', '--exit-code', '--', freezePath)
  const freeze = git('show', `${freezeCommit}:${freezePath}`)
  return { protocolCommit, files, publication: { freezeCommit, freezeSha256: hash(freeze), freeze } }
}

const sources = {
  daily: dailySources,
  intraday: { development: noiseSources.development, holdout: noiseSources.holdout },
}
const trainHurdles = (ledgers: ReturnType<typeof buildLedgers>) =>
  ledgers.map(({ bp, books: paths }) => {
    const [shyPath] = paths
    const sharpes = paths.flatMap(({ rows }) => {
      const sr = dailySharpe(rows.slice(0, splits.train.count).map((row, i) => row.net - shyPath.rows[i].net))
      return sr === null ? [] : [sr]
    })
    return { bp, sampleSize: sharpes.length, hurdle: expectedMaximumSharpe(sharpes, paths.length) }
  })
const digests = (ledgers: ReturnType<typeof buildLedgers>) =>
  ledgers.map(({ bp, books: paths }) => ({
    bp,
    books: Object.fromEntries(paths.map(({ id, rows }) => [id, hash(JSON.stringify(rows))])),
  }))

class StudyError extends Data.TaggedError('OvernightEtfStudyError')<{ readonly message: string }> {}
const failure = (cause: unknown) => new StudyError({ message: cause instanceof Error ? cause.message : String(cause) })
const main = Effect.gen(function* () {
  const [stage, flag, output, ...rest] = process.argv.slice(2)
  if (
    (stage !== '--develop' && stage !== '--score') ||
    flag !== '--output' ||
    output === undefined ||
    output === '' ||
    rest.length > 0
  )
    return yield* new StudyError({
      message: 'Usage: research-10yr-etf-overnight-vs-intraday.ts (--develop | --score) --output <new JSON path>',
    })
  const lockedInputs = yield* Effect.try({
    try: () => {
      if (lstatSync(output, { throwIfNoEntry: false }) !== undefined) throw new Error(`Refusing to overwrite ${output}`)
      return verifyPublished(stage)
    },
    catch: failure,
  })
  const result = yield* withArchive(async (archive) => {
    const daily = await Promise.all(
      dailySources.map(async (source) => {
        const manifest = await archive.open(source.prefix + '/MANIFEST.json')
        const gzip = await archive.open(source.prefix + '/' + source.file)
        return { manifest: await manifest.bytes(), gzip: await gzip.bytes() }
      }),
    )
    const dev = await loadDevelopment(archive)
    const devSessions = loadSessions(daily, developmentEnd)
    const devLedgers = buildLedgers(devSessions, dev.days)
    const hurdles = trainHurdles(devLedgers)
    const freeze = {
      schema: 'bayn.research.wave-9a.freeze.v1',
      protocolCommit: lockedInputs.protocolCommit,
      files: lockedInputs.files,
      sources,
      coverage: dev.coverage,
      trialCount: devLedgers[0].books.length,
      hurdles,
      ledgerSha256: digests(devLedgers),
      ...comparisonReport(devLedgers, hurdles),
    }
    const publication = lockedInputs.publication
    if (publication === undefined) return freeze
    const holdout = await afterFreeze(serialize(freeze), publication.freeze, () => loadHoldout(archive))
    const sessions = loadSessions(daily, end)
    const ledgers = buildLedgers(sessions, [...dev.days, ...holdout.days])
    // Extending the tape must not change any result in the registered development window.
    const extendedPrefix = ledgers.map(({ bp, books: paths }) => ({
      bp,
      books: paths.map(({ id, rows }) => ({ id, rows: rows.slice(0, dev.days.length) })),
    }))
    if (serialize(digests(extendedPrefix)) !== serialize(freeze.ledgerSha256))
      throw new Error('Extending into Holdout changed a frozen development path')
    return {
      schema: 'bayn.research.wave-9a.results.v1',
      publication: {
        protocolCommit: freeze.protocolCommit,
        freezeCommit: publication.freezeCommit,
        freezeSha256: publication.freezeSha256,
      },
      sources,
      coverage: { development: dev.coverage, holdout: holdout.coverage },
      sessionCount: sessions.length,
      trialCount: freeze.trialCount,
      hurdles,
      ledgerSha256: digests(ledgers),
      etfs: decomposition(sessions, tiers),
      ...comparisonReport(ledgers, hurdles),
    }
  })
  yield* Effect.tryPromise({
    try: (signal) => writeFile(output, serialize(result), { flag: 'wx', signal }),
    catch: failure,
  })
  yield* Effect.logInfo(`Wrote ${output}`)
})

if (import.meta.main) NodeRuntime.runMain(main)
