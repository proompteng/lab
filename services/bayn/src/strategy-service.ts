import { Context, Layer } from 'effect'

import type { RuntimeProvenance } from './contracts'
import { evaluateTsmom } from './strategy'
import type { DailyBar, EvaluationResult, InputManifest, TsmomProtocol } from './types'

export interface StrategyService {
  readonly name: string
  readonly universe: readonly string[]
  readonly provenance: RuntimeProvenance
  readonly evaluate: (bars: readonly DailyBar[], manifest: InputManifest) => EvaluationResult
}

export class Strategy extends Context.Service<Strategy, StrategyService>()('bayn/Strategy') {}

export const makeTsmomStrategy = (protocol: TsmomProtocol, provenance: RuntimeProvenance): StrategyService => ({
  name: 'tsmom',
  universe: protocol.universe,
  provenance,
  evaluate: (bars, manifest) => evaluateTsmom(bars, manifest, protocol, provenance),
})

export const TsmomStrategyLayer = (protocol: TsmomProtocol, provenance: RuntimeProvenance) =>
  Layer.succeed(Strategy, makeTsmomStrategy(protocol, provenance))
