import type { MarketCalendarSession } from '../broker/alpaca/model'
import type { EquityProviderSession } from '../equity-hours'

/** Synthetic broker bounds equal the test's chosen session; actual extended hours are tested at normalization. */
export const withProviderSessions = <const A extends { readonly sessions: readonly MarketCalendarSession[] }>(
  material: A,
) => ({
  ...material,
  providerSessions: material.sessions.map<Omit<EquityProviderSession, 'date'> & Pick<A['sessions'][number], 'date'>>(
    (session) => ({
      date: session.date,
      regularOpenAt: session.openAt,
      regularCloseAt: session.closeAt,
      sessionOpenAt: session.openAt,
      sessionCloseAt: session.closeAt,
    }),
  ),
})
