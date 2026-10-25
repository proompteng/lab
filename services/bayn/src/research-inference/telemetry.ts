import { Effect, Metric } from 'effect'
import type { ResearchReceipt } from './contract'

const attempts = Metric.counter('bayn_research_attempts', { incremental: true })
const elapsed = Metric.histogram('bayn_research_inference_duration_ms', {
  boundaries: [10, 50, 100, 500, 1000, 5000, 10000, 30000, 60000, 120000, 180000],
})
const ttft = Metric.histogram('bayn_research_first_token_ms', {
  boundaries: [10, 50, 100, 500, 1000, 5000, 10000, 30000, 60000, 180000],
})
const tokens = Metric.counter('bayn_research_completion_tokens', { incremental: true })
export const recordResearchMetrics = (receipt: ResearchReceipt) =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(attempts, { outcome: receipt.outcome }), 1)
    yield* Metric.update(elapsed, receipt.completedAtMs - receipt.startedAtMs)
    if (receipt.firstTokenAtMs !== null) yield* Metric.update(ttft, receipt.firstTokenAtMs - receipt.startedAtMs)
    if (receipt.usage !== null) yield* Metric.update(tokens, receipt.usage.completion_tokens)
  })
export const researchReplayCounter = Metric.counter('bayn_research_retained_replays', { incremental: true })
export const researchHeartbeat = Metric.gauge('bayn_research_worker_heartbeat_seconds')

export const researchUnpriced = Metric.gauge('bayn_research_unpriced_attempts')
export const researchPendingExpenses = Metric.gauge('bayn_research_pending_expense_receipts')
export const researchExpenseLag = Metric.gauge('bayn_research_oldest_pending_expense_seconds')
export const researchAmbiguous = Metric.gauge('bayn_research_ambiguous_attempts')
