import { NodeRuntime } from '@effect/platform-node'
import { Console, Data, Effect, Redacted, Result, Schema } from 'effect'

import { loadDevelopment, loadHoldout, withArchive } from './noise-area-study-data'
import { netAt, splits, type Ledger } from './noise-area-study-replay'
import { armId, replaySessions } from './noise-area-v4-replay'
import { ledgerOf, lockDevelopment, purgeSessions, scoreHoldout } from './noise-area-v4-walk-forward'
import { prepareControls } from './research/event-calendar-etf-controls'
import { verifyBaseline } from './research-10yr-qqq-smh-conditioning'
import { S3ArchiveError } from './research-lib/s3-archive'
import { end, loadSessions, sources } from './vol-regime-carry-data'

enum Mode {
  Develop = '--develop',
  Score = '--score',
}

const args = Schema.Union([
  Schema.Tuple([Schema.Enum(Mode).pipe(Schema.refine((mode): mode is Mode.Develop => mode === Mode.Develop))]),
  Schema.Tuple([
    Schema.Enum(Mode).pipe(Schema.refine((mode): mode is Mode.Score => mode === Mode.Score)),
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ]),
])
const decodeArgs = Schema.decodeUnknownResult(args)

class StudyError extends Data.TaggedError('NoiseAreaV4StudyError')<{ readonly message: string }> {}

const root = new URL('../../../', import.meta.url)
const git = (...flags: string[]) => {
  const run = Bun.spawnSync(['git', ...flags], { cwd: root.pathname, stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`git ${flags[0]}: ${run.stderr.toString().trim()}`)
  return run.stdout.toString().trim()
}

const sourceCommit = () => {
  if (git('status', '--porcelain', '--', 'services/bayn', 'bun.lock') !== '')
    throw new Error('Commit the Bayn sources before developing or scoring a receipt')
  return git('rev-parse', 'HEAD')
}

// Wave 6A #16387 zero-cash net at 10 bp RT, alongside Wave 9B's existing 2/5 bp verification.
const baseline10 = { train: -15_696.43, validation: 12_284.44, holdout: 16_936.44, full: 13_524.45 }
const checkBaseline = (rows: readonly Ledger[], window: keyof typeof baseline10) => {
  verifyBaseline(rows, window)
  let total = 0
  for (const row of rows) {
    const pnl = netAt(row, 10)
    if (pnl === null) throw new Error(`Unresolved Wave 6A baseline in ${window}`)
    total += pnl
  }
  if (Math.round(total * 100) !== Math.round(baseline10[window] * 100))
    throw new Error(`Wave 6A baseline mismatch (${window}, 10 bp RT): ${total} vs ${baseline10[window]}`)
}

const loadDailyControlSessions = async (open: (key: string) => Promise<Response>) => {
  const read = async (key: string) =>
    (await open(key)).bytes().catch((cause: unknown) => {
      throw new S3ArchiveError({ message: `Unable to read archive body: ${key}`, cause: Redacted.make(cause) })
    })
  const inputs = []
  for (const source of sources) {
    inputs.push({
      manifest: await read(`${source.prefix}/MANIFEST.json`),
      gzip: await read(`${source.prefix}/${source.file}`),
    })
  }
  return loadSessions(inputs, end)
}

/** Verify before invoking any reader of sealed Holdout inputs. */
export const withDevelopmentReceipt = <A>(receipt: string, expected: string, readHoldout: () => Promise<A>) => {
  if (receipt !== expected) throw new Error('Development receipt mismatch; Holdout not opened')
  return readHoldout()
}

const number = (value: number | null, multiplier = 1) => (value === null ? '—' : (value * multiplier).toFixed(4))

const render = (commit: string, lock: ReturnType<typeof lockDevelopment>, result?: ReturnType<typeof scoreHoldout>) =>
  [
    '# ETF Noise Area v4 research',
    '',
    `Source: \`${commit}\`; development receipt: \`${lock.receipt}\``,
    `Locked arm: **${armId(lock.selected)}**; fit through ${lock.fitThrough} with ${purgeSessions} purged sessions.`,
    '',
    '| Dev forward year | Fit through | OOS sessions | Fit-selected arm | 5 bp ΔCAGR pp / ΔSharpe | 10 bp ΔCAGR pp / ΔSharpe |',
    '| --- | --- | ---: | --- | ---: | ---: |',
    ...lock.folds.map(
      ({ year, fitThrough, sessions, arm, atStress }) =>
        `| ${year} | ${fitThrough} | ${sessions} | ${arm} | ${atStress.map(({ cagr, sharpe }) => `${number(cagr, 100)} / ${number(sharpe)}`).join(' | ')} |`,
    ),
    ...(result === undefined
      ? []
      : [
          '',
          `Holdout verdict: **${result.passes ? 'PASS (research only)' : 'NO PROMOTION'}**. Unlocked arms are descriptive, not replacements.`,
          '',
          '| RT bp | Arm | CAGR % | ΔCAGR pp | Sharpe | ΔSharpe | DSR | MaxDD % | Daily turnover % | ρ B0 / F4 / O1 | Paired p | Path complete |',
          '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |',
          ...result.scores.flatMap(({ bp, arms }) =>
            arms.map(
              (arm) =>
                `| ${bp} | ${arm.id} | ${number(arm.cagr, 100)} | ${number(arm.deltaCagr, 100)} | ${number(arm.sharpe)} | ${number(arm.deltaSharpe)} | ${number(arm.dsr)} | ${number(arm.drawdown, 100)} | ${number(arm.turnover, 100)} | ${arm.correlations.map((rho) => number(rho)).join(' / ')} | ${number(arm.pairedP)} | ${arm.complete ? 'yes' : 'no'} |`,
            ),
          ),
          '',
          '| Holdout year | Sessions | RT bp | Locked arm ΔCAGR pp | Locked arm ΔSharpe |',
          '| --- | ---: | ---: | ---: | ---: |',
          ...result.folds.flatMap(({ year, sessions, costs }) =>
            costs.map(
              ({ bp, cagr, sharpe }) => `| ${year} | ${sessions} | ${bp} | ${number(cagr, 100)} | ${number(sharpe)} |`,
            ),
          ),
          ...(result.components.length === 0
            ? []
            : [
                '',
                '| Locked component | RT bp | Alone vs B0 ΔCAGR pp / ΔSharpe | Added to remainder ΔCAGR pp / ΔSharpe | Passes both costs |',
                '| --- | ---: | ---: | ---: | --- |',
                ...result.components.flatMap(({ part, passes, atStress }) =>
                  atStress.map(
                    ({ bp, alone, added }) =>
                      `| ${part} | ${bp} | ${number(alone.cagr, 100)} / ${number(alone.sharpe)} | ${number(added.cagr, 100)} / ${number(added.sharpe)} | ${passes ? 'yes' : 'no'} |`,
                  ),
                ),
              ]),
        ]),
  ].join('\n')

const program = Effect.gen(function* () {
  const parsed = decodeArgs(Bun.argv.slice(2))
  if (Result.isFailure(parsed))
    return yield* new StudyError({ message: 'Usage: --develop | --score <development receipt SHA-256>' })
  const commit = yield* Effect.try({
    try: sourceCommit,
    catch: (cause) =>
      new StudyError({ message: cause instanceof Error ? cause.message : 'Cannot verify source revision' }),
  })
  const [mode, receipt] = parsed.success
  const markdown = yield* withArchive(async (archive) => {
    const { days } = await loadDevelopment(archive)
    const development = replaySessions(days)
    const priorB0 = ledgerOf(development, [])
    checkBaseline(priorB0.slice(0, splits.train.count), 'train')
    checkBaseline(priorB0.slice(splits.train.count), 'validation')
    const lock = lockDevelopment(development, commit)
    if (mode === Mode.Develop) return render(commit, lock)

    return withDevelopmentReceipt(lock.receipt, receipt, async () => {
      const holdout = await loadHoldout(archive)
      const intraday = [...days, ...holdout.days]
      const all = replaySessions(intraday)
      const sample = all.slice(days.length)
      checkBaseline(ledgerOf(all, []), 'full')
      checkBaseline(ledgerOf(sample, []), 'holdout')
      const daily = await loadDailyControlSessions(archive.open)
      const controls = prepareControls(daily, intraday)
      const result = scoreHoldout(sample, lock, (bp) => {
        const { B0, F4, O1 } = controls.at(bp)
        return B0.map(({ date, net }, i) => {
          const returns = { B0: net, F4: F4[i].net, O1: O1[i].net }
          if (Object.values(returns).some((value) => !Number.isFinite(value)))
            throw new Error(`Non-finite control return on ${date}`)
          return { date, returns }
        }).slice(days.length)
      })
      return render(commit, lock, result)
    })
  }).pipe(Effect.timeout('5 minutes'))
  yield* Console.log(markdown)
})

if (import.meta.main) NodeRuntime.runMain(program)
