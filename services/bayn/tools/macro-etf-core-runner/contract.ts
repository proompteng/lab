import { parseArgs } from 'node:util'

import { Data, Result, Schema } from 'effect'

import { Profile } from '../../src/strategy/macro-etf-core/policy'
import { AccountId } from '../macro-canary-runner/alpaca'
import { Mode, TimeInForce } from '../macro-canary-runner/contract'
import { cents, overnightCapCents } from '../macro-canary-runner/planner'

export enum RunnerProfile {
  F2 = Profile.F2,
  F4 = Profile.F4,
  Equal = 'F2_F4_EQUAL',
}

const isProfile = Schema.is(Schema.Enum(RunnerProfile))
const isMode = Schema.is(Schema.Enum(Mode))
const isTif = Schema.is(Schema.Enum(TimeInForce))
const isAccountId = Schema.is(AccountId)

export const intradaySymbols = ['QQQ', 'SMH'] as const

export class RebalanceFailure extends Data.TaggedError('MacroEtfCoreRebalanceFailure')<{
  readonly stage: string
  readonly message: string
  readonly cause?: unknown
}> {}

export const failure = (stage: string, message: string, cause?: unknown) =>
  new RebalanceFailure({ stage, message, ...(cause === undefined ? {} : { cause }) })

export const usage = [
  'Usage: bun services/bayn/tools/run-macro-etf-core-rebalance.ts --output <new-receipt.json>',
  '  [--profile F2|F4|F2_F4_EQUAL] [--exclude-symbols QQQ,SMH] [--capital-budget-usd 50000]',
  '  [--tif opg|day] [--mode shadow|paper-submit] [--confirm-paper-account <uuid>]',
  '  Use --exclude-symbols "" only with verified isolated shadow credentials.',
].join('\n')

export const parseOptions = (args: readonly string[]) =>
  Result.gen(function* () {
    const { values, tokens } = yield* Result.try({
      try: () =>
        parseArgs({
          args: [...args],
          options: {
            output: { type: 'string' },
            profile: { type: 'string', default: RunnerProfile.F4 },
            mode: { type: 'string', default: Mode.Shadow },
            'confirm-paper-account': { type: 'string' },
            'exclude-symbols': { type: 'string', default: intradaySymbols.join(',') },
            'capital-budget-usd': { type: 'string' },
            tif: { type: 'string', default: TimeInForce.Open },
          },
          tokens: true,
        }),
      catch: () => failure('config', usage),
    })
    const { mode, profile, tif, output, 'confirm-paper-account': accountId, 'capital-budget-usd': budget } = values
    const isolatedShadow = mode === Mode.Shadow && values['exclude-symbols'] === ''
    const exclusions = isolatedShadow
      ? []
      : values['exclude-symbols'].split(',').map((symbol) => symbol.trim().toUpperCase())
    if (
      new Set(tokens.map((token) => (token.kind === 'option' ? token.name : ''))).size !== tokens.length ||
      !isProfile(profile) ||
      !isMode(mode) ||
      !isTif(tif) ||
      output === undefined ||
      output.trim().length === 0 ||
      exclusions.some((symbol) => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) ||
      (budget !== undefined && !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(budget))
    )
      return yield* Result.fail(failure('config', usage))

    const capitalBudgetCents = budget === undefined ? overnightCapCents : cents(budget)
    if (capitalBudgetCents <= 0 || capitalBudgetCents > overnightCapCents)
      return yield* Result.fail(failure('config', '--capital-budget-usd must be positive and no more than 150000'))
    if ((mode === Mode.PaperSubmit && !isAccountId(accountId)) || (mode === Mode.Shadow && accountId !== undefined))
      return yield* Result.fail(
        failure('config', 'Only paper-submit accepts and requires --confirm-paper-account <uuid>'),
      )

    return {
      profile,
      mode,
      tif,
      output,
      confirmPaperAccount: accountId,
      excludeSymbols: isolatedShadow ? [] : [...new Set([...intradaySymbols, ...exclusions])].sort(),
      capitalBudgetCents,
    }
  })

export type Options = Result.Result.Success<ReturnType<typeof parseOptions>>
