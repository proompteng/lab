import { expect, test } from 'bun:test'

import { Result } from 'effect'

import { canonicalHashV1Result } from '../../src/hash'
import { universe } from '../../src/strategy/macro-etf-core/policy'
import { RunnerProfile } from '../macro-etf-core-runner/contract'
import { CanaryProfile, decodeManifest, makePortfolioReceipt, SleeveMode, Strategy } from './contract'

const accountId = '11111111-1234-4234-8123-000000000001'
const secondAccountId = '22222222-1234-4234-8123-000000000002'
const intradayAccountId = '33333333-1234-4234-8123-000000000003'
const core = {
  sleeveId: 'macro-core',
  strategy: Strategy.MacroEtfCore,
  profile: RunnerProfile.F4,
  accountId,
  credentialsEnvPrefix: 'MACRO_CORE',
  capitalBudgetUsd: 50_000,
}
const canary = {
  ...core,
  strategy: Strategy.MacroCanaryEtf,
  profile: CanaryProfile.O1,
  sleeveId: 'macro-canary',
  credentialsEnvPrefix: 'MACRO_CANARY',
  accountId: secondAccountId,
}
const serialized = (sleeves: readonly unknown[], allowSharedAccount = false) =>
  JSON.stringify({
    schemaVersion: 'bayn.multi-account-daily-sleeves-config.v1',
    intradayAccountId,
    allowSharedAccount,
    sleeves,
  })

const rejection = (sleeves: readonly unknown[], code: string, shared = false, confirm = false) => {
  const result = decodeManifest(serialized(sleeves, shared), confirm)
  expect(Result.isFailure(result) && result.failure).toMatchObject({ code })
}

test('dedicated sleeves are independent even when both target QQQ, and default to Shadow', () => {
  const manifest = Result.getOrThrow(decodeManifest(serialized([core, canary]), true))
  expect(
    manifest.sleeves.map(({ mode, excludeSymbols, activeSymbols, capitalBudgetCents }) => ({
      mode,
      excludeSymbols,
      hasQqq: activeSymbols.some((symbol) => symbol === 'QQQ'),
      capitalBudgetCents,
    })),
  ).toEqual(Array(2).fill({ mode: SleeveMode.Shadow, excludeSymbols: [], hasQqq: true, capitalBudgetCents: 5_000_000 }))
})

test('account sharing requires opt-in and pairwise disjoint entire tradable universes', () => {
  const first = { ...core, excludeSymbols: universe.filter((symbol) => symbol !== 'QQQ') }
  const second = { ...canary, accountId, excludeSymbols: ['QQQ'] }
  rejection([first, second], 'DuplicateAccount')
  rejection([first, { ...second, excludeSymbols: [] }], 'SharedAccountSymbolOverlap', true)
  expect(Result.isSuccess(decodeManifest(serialized([first, second], true), false))).toBe(true)
  rejection(
    [first, second, { ...core, sleeveId: 'third', excludeSymbols: universe.filter((symbol) => symbol !== 'SPY') }],
    'SharedAccountSymbolOverlap',
    true,
  )
  rejection([core, { ...canary, sleeveId: core.sleeveId }], 'DuplicateSleeveId')
  rejection([{ ...core, excludeSymbols: universe }], 'EmptyActiveUniverse')
})

test('intraday sharing requires both QQQ and SMH exclusions and an explicit opt-in', () => {
  const same = { ...core, accountId: intradayAccountId }
  for (const excludeSymbols of [[], ['QQQ'], ['SMH']])
    rejection([{ ...same, excludeSymbols }], 'IntradayAccountNotIsolated', true)
  const excluded = { ...same, excludeSymbols: ['QQQ', 'SMH'] }
  rejection([excluded], 'IntradayAccountNotIsolated')
  expect(Result.isSuccess(decodeManifest(serialized([excluded], true), false))).toBe(true)
})

test('only a matching strategy profile and the CLI confirmation can authorize PaperSubmit', () => {
  rejection([{ ...core, profile: CanaryProfile.O1 }], 'IncompatibleStrategyProfile')
  rejection([{ ...canary, profile: RunnerProfile.Equal }], 'IncompatibleStrategyProfile')
  const paper = { ...core, mode: SleeveMode.PaperSubmit }
  rejection([paper], 'PaperSubmitNotConfirmed')
  expect(Result.isSuccess(decodeManifest(serialized([paper]), true))).toBe(true)
  rejection([{ ...core, mode: 'paper-submit' }], 'InvalidManifest', false, true)
})

test('strict JSON and budget validation keep rejected data and unknown property names out of errors', () => {
  const secret = 'do-not-echo-this-key-or-value'
  for (const payload of [
    serialized([{ ...core, credentialsEnvPrefix: secret }]),
    serialized([{ ...core, [secret]: secret }]),
    serialized([{ ...core, capitalBudgetUsd: '50000' }]),
    serialized([{ ...core, capitalBudgetUsd: 0.001 }]),
    serialized([{ ...core, capitalBudgetUsd: 150_000.01 }]),
    serialized([{ ...core, accountId: core.accountId.toUpperCase().replace(/^1/, 'G') }]),
    serialized([{ ...core, excludeSymbols: ['qqq'] }]),
    serialized([]),
    `bad json "${secret}`,
  ]) {
    const result = decodeManifest(payload, false)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ code: 'InvalidManifest', cause: { issues: expect.any(Array) } })
      expect(JSON.stringify(result.failure)).not.toContain(secret)
    }
  }
})

test('portfolio digest covers account verification, partial exposure and failure evidence', () => {
  const manifest = Result.getOrThrow(decodeManifest(serialized([core, canary]), false))
  const receipt = Result.getOrThrow(
    makePortfolioReceipt(manifest, [
      {
        sleeveId: canary.sleeveId,
        accountId: secondAccountId,
        verifiedAccountId: null,
        disposition: 'failed',
        plan: null,
        error: { stage: 'reconcile', code: 'AccountMismatch' },
      },
      {
        sleeveId: core.sleeveId,
        accountId,
        verifiedAccountId: accountId,
        disposition: 'shadow',
        plan: {
          signalSession: '2026-11-24',
          executionSession: '2026-11-25',
          targetExposure: [{ symbol: 'QQQ', targetCents: 101 }],
          receipt: {},
        },
        error: null,
      },
    ]),
  )
  expect(receipt.isolation.allBrokerAccountsVerified).toBe(false)
  expect(receipt.aggregateTargetExposure).toEqual({
    targetCentsBySymbol: { QQQ: 101 },
    complete: false,
    includedSleeveIds: ['macro-core'],
  })
  const { portfolioSha256, ...material } = receipt
  expect(Result.getOrThrow(canonicalHashV1Result(material))).toBe(portfolioSha256)
})
