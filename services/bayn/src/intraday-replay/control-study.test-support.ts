import { gzipSync } from 'node:zlib'
import { Result } from 'effect'
import { BrokerEnvironment } from '../broker/identity'
import { EntryTurnoverPolicy } from '../execution/turnover-reserve'
import { canonicalHashV1Result, sha256 } from '../hash'
import { jevModel } from '../jev/contract'
import { jevInstructions } from '../jev/instructions'
import { equityMarketProfile } from '../jev/markets'
import { replayRateCardFixture } from '../testing/inference-rate-card.test-support'
import { replayTestInstruments } from '../testing/replay-instruments'
import { retainedReplayFixture, retainedReplayCaptureFixture } from '../testing/retained-replay-fixture'
import { config } from '../testing/runtime-fixtures'
import { ControlManagementMode } from './control-study'

export const assumptions = {
  instruments: replayTestInstruments,
  latencyMs: 100,
  slippageBps: 1,
  availableLiquidityPpm: 1_000_000,
  feeMultiplierPpm: 1_000_000,
}

export const compressedControlFixture = (body: string) => {
  const compressed = gzipSync(body)
  compressed[9] = 3
  return compressed
}

export const frozenControlFixture = () => {
  const retained = retainedReplayFixture()
  const source = {
    ...retained.manifest,
    dataSha256: sha256(compressedControlFixture(retained.body)),
    coverageStartMs: Date.parse('2026-09-04T13:30:00Z'),
    coverageEndMs: Date.parse('2026-09-08T20:00:00Z'),
  }
  const { verification: _verification, ...build } = config.build
  const input = {
    schemaVersion: 'bayn.control-study-input.v10',
    riskEnvironment: BrokerEnvironment.Live,
    openingPeakEquityMicros: '100000000000',
    costObjective: 'ALL_COSTS',
    entry: 'DETERMINISTIC',
    turnoverPolicy: EntryTurnoverPolicy.ImmediateAdjustment,
    management: ControlManagementMode.Mechanical,
    decisionLatencyMs: 1000,
    repeatedTargetWeightPpm: 100000,
    backtest: {
      schemaVersion: 'bayn.backtest.v11',
      policy: 'JEV' as const,
      latencyStress: null,
      jevInstructionsHash: Result.getOrThrow(canonicalHashV1Result(jevInstructions)),
      inference: {
        mode: 'measured-providers',
        maximumCalls: 1000,
        models: { jev: jevModel },
        inputDefinition: 'bayn.jev-entry-state.v24',
        costs: replayRateCardFixture({
          jev: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
          chart: {
            inputMicrosPerMillionTokens: '100000',
            outputMicrosPerMillionTokens: '0',
            cachedInputMicrosPerMillionTokens: '10000',
            cacheWriteInputMicrosPerMillionTokens: '125000',
          },
        }),
      },
      allocatedDataCostPerSessionMicros: '1000000',
      replicate: 'control-source-fixture',
      interval: { startAt: '2026-09-04T13:30:00.000Z', endAt: '2026-09-08T20:00:00.000Z' },
      source,
      openingCashMicros: '100000000000',
      fractionalTrading: false,
      calendar: [
        ...retained.input.input.calendar,
        { session_open: '0930', session_close: '1600', date: '2026-09-08', open: '09:30', close: '16:00' },
        { session_open: '0930', session_close: '1600', date: '2026-09-09', open: '09:30', close: '16:00' },
      ],
      assets: equityMarketProfile.universe.map((symbol, index) => ({
        id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
        symbol,
        class: 'us_equity',
        exchange: 'NASDAQ',
        status: 'active',
        tradable: true,
        fractionable: true,
      })),
      assetObservationAt: '2026-09-04T13:29:00.000Z',
      assetObservationPolicy: 'retained-as-of-session',
      build,
      assumptions,
      cadence: {
        pollIntervalMs: 30000,
        reconciliationIntervalMs: 30000,
        reconciliationPassTimeoutMs: 30000,
        reconciliationStaleThresholdMs: 120000,
      },
    },
  }
  const receipt = retainedReplayCaptureFixture(source)
  return { retained, source, input, receipt }
}
