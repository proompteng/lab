import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from '../../shared/cli'

const rules = readFileSync(join(repoRoot, 'argocd/applications/observability/graf-mimir-rules.yaml'), 'utf8')
const runbook = readFileSync(join(repoRoot, 'docs/runbooks/torghut-quant-control-plane.md'), 'utf8')

describe('Torghut quant control-plane alerts', () => {
  it('distinguishes a stalled strategy loop from fail-closed quote rejection', () => {
    const stalledAlert = rules
      .split('- alert: TorghutQuantDecisionsStalledDuringMarketHours')[1]
      .split('- alert: TorghutExecutableQuoteCoverageDegradedDuringMarketHours')[0]

    expect(rules).toContain('alert: TorghutQuantDecisionsStalledDuringMarketHours')
    expect(stalledAlert).toContain('torghut_trading_decisions_total')
    expect(stalledAlert).toContain('torghut_trading_strategy_events_total')
    expect(stalledAlert).toContain('torghut_trading_rejected_signal_reason_total')
    expect(stalledAlert).toContain('reason=~"missing_executable_quote|spread_bps_exceeded"')
  })

  it('alerts on sustained executable quote coverage failures without weakening safety gates', () => {
    expect(rules).toContain('alert: TorghutExecutableQuoteCoverageDegradedDuringMarketHours')
    expect(rules).toContain('reason=~"missing_executable_quote|spread_bps_exceeded"')
    expect(rules).toContain(
      'Check quote-source entitlement and venue coverage; do not weaken spread or freshness gates.',
    )
    expect(runbook).toContain('Alpaca IEX is a single-exchange feed')
    expect(runbook).toContain('Do not synthesize bid/ask values')
  })
})
