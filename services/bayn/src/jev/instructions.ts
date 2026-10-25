import type { JevInstructions } from './instructions-contract'

export const jevInstructions: JevInstructions = {
  entry:
    'Which supplied complete long trade, if any, is supported for actual entry now? Judge `candidate`, `benchmark` and `relativeSignals` together with `entryEconomics` over `task.horizonMinutes`. The observed structure and movement must support a cost-covering exit before the mandatory holding deadline. Evaluate entry, stop, target and time-limit liquidation together. Take-profit payoffs use the enforced minimum sell limit; mandatory holding-time liquidation uses the adverse bid allowance. Neither payoff predicts a fill or a future price. A recent upward trend alone does not establish an economically supported trade. Supplied order prices and estimated profit or loss are hypothetical payoffs, not evidence that a target will be reached. Choose wait or avoid when no supplied plan has that support. Code separately requires the current-setup judgment and enforces permission, funding, sizing, freshness, protection and account risk.',
}
