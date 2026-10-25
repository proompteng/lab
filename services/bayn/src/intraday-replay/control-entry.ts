import { Result } from 'effect'
import { AccountStatus, ReconciliationStatus } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { makeJevObservation } from '../jev/observation'
import { decodeJevPortfolio, JevPurpose } from '../jev/portfolio'
import type { JevProtocol } from '../jev/protocol'
import type { VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { ControlStudyFailure, type ControlPortfolio } from './control-portfolio'

export const makeControlEntryObservation = (input: {
  readonly runId: string
  readonly protocol: JevProtocol
  readonly snapshot: VerifiedStrategyMarketSnapshot
  readonly portfolio: ControlPortfolio
}) =>
  Result.gen(function* () {
    if (input.portfolio.inventory.status !== 'FLAT' || input.portfolio.ledger.positions.length !== 0)
      return yield* Result.fail(
        new ControlStudyFailure({ message: 'Native entry requires this independent portfolio to be flat' }),
      )
    const { runId, protocol, snapshot } = input
    const at = snapshot.manifest.observedAt
    const accountId = `research-control-${runId}`
    const material: Parameters<typeof reconciledStateHash>[0] = {
      account: {
        schemaVersion: 'bayn.paper-account-snapshot.v2',
        cryptoFeeTier: null,
        accountId,
        status: AccountStatus.Active,
        currency: 'USD',
        cashMicros: input.portfolio.ledger.cashMicros,
        equityMicros: input.portfolio.ledger.cashMicros,
        buyingPowerMicros: input.portfolio.ledger.cashMicros,
        observedAt: at,
      },
      positions: [],
      positionsObservedAt: at,
      orders: [],
      ordersObservedAt: at,
      accountingHash: yield* canonicalHashV1Result(input.portfolio.ledger),
    }
    const stateHash = yield* reconciledStateHash(material)
    const portfolio = yield* decodeJevPortfolio({
      purpose: JevPurpose.Entry,
      brokerState: {
        ...material,
        unknownOrderCount: 0,
        reconciliation: {
          schemaVersion: 'bayn.paper-reconciliation.v1',
          accountId,
          reconciliationId: yield* canonicalHashV1Result({ runId, at, stateHash }),
          expectedHash: stateHash,
          observedHash: stateHash,
          contentHash: yield* canonicalHashV1Result(material),
          status: ReconciliationStatus.Exact,
          discrepancies: [],
          reconciledAt: at,
        },
      },
    })
    return yield* makeJevObservation({
      cycleId: yield* canonicalHashV1Result({ runId, sessionDate: snapshot.manifest.sessionDate }),
      authorityGenerationHash: yield* canonicalHashV1Result({ runId, scope: 'SIMULATED_CONTROL', protocol }),
      protocol,
      portfolio,
      snapshot,
    })
  })
