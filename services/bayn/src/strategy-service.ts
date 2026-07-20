import { Context, Layer } from 'effect'

import { defaultProtocol } from './protocol'
import { evaluateTsmom } from './strategy'
import type { DailyBar, EvaluationResult, InputManifest, TsmomProtocol } from './types'

export interface StrategyService {
  readonly name: string
  readonly universe: readonly string[]
  readonly evaluate: (bars: readonly DailyBar[], manifest: InputManifest, codeRevision: string) => EvaluationResult
}

export class Strategy extends Context.Service<Strategy, StrategyService>()('bayn/Strategy') {}

export const makeTsmomStrategy = (protocol: TsmomProtocol): StrategyService => ({
  name: 'tsmom',
  universe: protocol.universe,
  evaluate: (bars, manifest, codeRevision) => evaluateTsmom(bars, manifest, protocol, codeRevision),
})

export const tsmomStrategy = makeTsmomStrategy(defaultProtocol)

export const TsmomStrategyLive = Layer.succeed(Strategy, tsmomStrategy)
