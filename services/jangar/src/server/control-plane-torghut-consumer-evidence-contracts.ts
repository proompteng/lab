import type { TorghutNegativeEvidenceInput } from '~/server/control-plane-negative-evidence-router-torghut'
import { normalizeNonEmpty, stringValues, uniqueStrings } from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '~/server/primitives-http'

export const CONSUMER_EVIDENCE_CONTRACT_CANARY_SCHEMA_VERSION = 'torghut.consumer-evidence-contract-canary.v1'
export const ROUTE_WARRANT_EXCHANGE_SCHEMA_VERSION = 'torghut.route-warrant-exchange.v1'
export const REPAIR_BID_SETTLEMENT_LEDGER_SCHEMA_VERSION = 'torghut.repair-bid-settlement-ledger.v1'
export const CONTRACT_TRANSPORT_UNAVAILABLE_REASON = 'torghut_contract_transport_unavailable'

const SOURCE_SERVING_CONTRACTS = ['route_warrant_exchange', 'repair_bid_settlement_ledger']

export const hasRouteWarrantPayload = (payload: Record<string, unknown> | null | undefined) =>
  Boolean(
    payload && asRecord(payload.route_warrant_exchange ?? payload.route_warrant_exchange_v1 ?? payload.route_warrant),
  )

export const readContractCanary = (payload: Record<string, unknown> | null) => {
  const canary = asRecord(payload?.contract_canary_refs ?? payload?.consumer_evidence_contract_canary)
  const schema = normalizeNonEmpty(canary?.schema_version)
  if (schema && schema !== CONSUMER_EVIDENCE_CONTRACT_CANARY_SCHEMA_VERSION) {
    return canary
  }
  return canary
}

export const contractRef = (payload: Record<string, unknown> | null, contractName: string) => {
  const canary = readContractCanary(payload)
  return asRecord(asRecord(canary?.contract_refs)?.[contractName])
}

export const payloadHasSourceServingContractRefs = (payload: Record<string, unknown> | null) => {
  const canary = readContractCanary(payload)
  const observedContracts = uniqueStrings([
    ...stringValues(payload?.observed_contracts),
    ...stringValues(canary?.observed_contracts),
  ])
  const routeWarrant = asRecord(
    payload?.route_warrant_exchange ?? payload?.route_warrant_exchange_v1 ?? payload?.route_warrant,
  )
  const repairBidSettlement = asRecord(payload?.repair_bid_settlement_ledger)
  const routeWarrantRef = normalizeNonEmpty(
    payload?.route_warrant_id ??
      routeWarrant?.warrant_id ??
      routeWarrant?.exchange_id ??
      contractRef(payload, 'route_warrant_exchange')?.ref,
  )
  const repairBidRef = normalizeNonEmpty(
    payload?.repair_bid_settlement_ledger_id ??
      repairBidSettlement?.ledger_id ??
      contractRef(payload, 'repair_bid_settlement_ledger')?.ref,
  )
  return (
    SOURCE_SERVING_CONTRACTS.every((contract) => observedContracts.includes(contract)) ||
    Boolean(routeWarrantRef && repairBidRef)
  )
}

export const readMarketContext = (
  payload: Record<string, unknown>,
): Pick<TorghutNegativeEvidenceInput, 'market_context_status' | 'market_context_stale_domains'> => {
  const marketContext = asRecord(payload.market_context)
  const health = asRecord(marketContext?.health)
  const status = normalizeNonEmpty(health?.status ?? marketContext?.status ?? marketContext?.last_reason)
  const domains = asRecord(marketContext?.last_domain_states)
  const staleDomains =
    domains && typeof domains === 'object'
      ? Object.entries(domains)
          .filter(([, value]) => {
            const domain = asRecord(value)
            return normalizeNonEmpty(domain?.status) === 'stale' || domain?.stale === true
          })
          .map(([key]) => key)
      : []

  if (status === 'ok' || status === 'healthy') {
    return { market_context_status: 'healthy', market_context_stale_domains: staleDomains }
  }
  if (status === 'stale') {
    return { market_context_status: 'stale', market_context_stale_domains: staleDomains }
  }
  if (status === 'degraded') {
    return { market_context_status: 'degraded', market_context_stale_domains: staleDomains }
  }
  return { market_context_status: undefined, market_context_stale_domains: staleDomains }
}
