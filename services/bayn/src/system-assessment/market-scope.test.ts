import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { MarketKind } from '../instruments'
import { currentEntryMarkets } from '../execution/trading-scope'
import { cryptoMarketProfile, equityMarketProfile } from '../jev/markets'
import { continuousMarketHours } from '../market-hours'
import { registrationFixture, calendarFixture, withRegistrationCommitments } from './fixtures.test-support'
import { sourceFitsRegisteredSession } from './decision-work'
import { validateSystemRegistration, verifyStoredSystemRegistration } from './policy'

test('an explicit equity-only runtime can register and reproduce an equity-only financial evaluation', () => {
  const base = registrationFixture()
  const registration = withRegistrationCommitments({
    ...base,
    calendar: { ...base.calendar, tradingMarkets: [...currentEntryMarkets] },
    obligations: {
      ...base.obligations,
      configuration: { ...base.obligations.configuration, entryMarkets: [...currentEntryMarkets] },
    },
  })
  expect(currentEntryMarkets).toEqual([MarketKind.Equity])
  expect(Result.isSuccess(validateSystemRegistration(registration))).toBe(true)
  expect(Result.isSuccess(verifyStoredSystemRegistration(registration))).toBe(true)
})

test('unscoped registrations retain both native trading markets separately from the exchange session calendar', () => {
  const registration = registrationFixture()
  expect(registration.calendar).toMatchObject({
    referenceMarket: 'US_EQUITIES',
    tradingMarkets: [MarketKind.Equity, MarketKind.Crypto],
    operatingHours: 'REGULAR_SESSION',
  })
  expect(Result.isSuccess(validateSystemRegistration(registration))).toBe(true)
  for (const tradingMarkets of [[MarketKind.Equity], [MarketKind.Crypto], [], [MarketKind.Equity, MarketKind.Equity]])
    expect(
      Result.isFailure(
        validateSystemRegistration({
          ...registration,
          calendar: { ...registration.calendar, tradingMarkets },
        }),
      ),
    ).toBe(true)
})

test('financial scope cannot omit a registered entry market and may retain native exit markets', () => {
  const base = registrationFixture()
  for (const entryMarkets of [[MarketKind.Equity], [MarketKind.Equity, MarketKind.Crypto]]) {
    const registration = withRegistrationCommitments({
      ...base,
      obligations: {
        ...base.obligations,
        configuration: { ...base.obligations.configuration, entryMarkets },
      },
    })
    expect(Result.isSuccess(validateSystemRegistration(registration))).toBe(true)
    for (const tradingMarkets of [[MarketKind.Equity], [MarketKind.Crypto]]) {
      const result = validateSystemRegistration({
        ...registration,
        calendar: { ...registration.calendar, tradingMarkets },
      })
      expect(Result.isSuccess(result)).toBe(entryMarkets.every((market) => tradingMarkets.includes(market)))
    }
  }
})

test.each([true, false])(
  'regular-session financial scope includes crypto evidence only when registered: %s',
  (includeCrypto) => {
    const base = registrationFixture()
    const registration = withRegistrationCommitments({
      ...base,
      calendar: {
        ...base.calendar,
        tradingMarkets: includeCrypto ? [MarketKind.Equity, MarketKind.Crypto] : [MarketKind.Equity],
      },
      obligations: {
        ...base.obligations,
        configuration: { ...base.obligations.configuration, entryMarkets: [...currentEntryMarkets] },
      },
    })
    const first = registration.calendar.sessions[0]
    if (first === undefined) throw new Error('Missing registered session')
    const crypto = {
      sessionDate: first.sessionDate,
      calendar: continuousMarketHours,
      feed: cryptoMarketProfile.feed,
      universeId: cryptoMarketProfile.universeId,
      universeSymbolHash: cryptoMarketProfile.universeSymbolHash,
    }
    const observedAt = new Date(Date.parse(first.openAt) + 1000).toISOString()
    expect(sourceFitsRegisteredSession(crypto, registration, observedAt)).toBe(includeCrypto)
    for (const changed of [
      { ...crypto, feed: 'sip' },
      { ...crypto, universeId: equityMarketProfile.universeId },
      { ...crypto, universeSymbolHash: equityMarketProfile.universeSymbolHash },
      { ...crypto, calendar: calendarFixture(registration) },
      { ...crypto, sessionDate: '2026-11-01' },
    ])
      expect(sourceFitsRegisteredSession(changed, registration, observedAt)).toBe(false)
    for (const at of [
      new Date(Date.parse(first.openAt) - 1).toISOString(),
      first.closeAt,
      `${first.sessionDate}T23:59:59.000Z`,
    ])
      expect(sourceFitsRegisteredSession(crypto, registration, at)).toBe(false)
    const equity = {
      ...crypto,
      calendar: calendarFixture(registration),
      feed: equityMarketProfile.feed,
      universeId: equityMarketProfile.universeId,
      universeSymbolHash: equityMarketProfile.universeSymbolHash,
    }
    expect(sourceFitsRegisteredSession(equity, registration, observedAt)).toBe(true)
    expect(sourceFitsRegisteredSession({ ...equity, calendar: continuousMarketHours }, registration, observedAt)).toBe(
      false,
    )
    expect(
      sourceFitsRegisteredSession(
        { ...equity, universeSymbolHash: crypto.universeSymbolHash },
        registration,
        observedAt,
      ),
    ).toBe(false)
  },
)
