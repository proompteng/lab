import { PgMigrator } from '@effect/sql-pg'

import initialSchema from '../../migrations/0001_initial_schema'
import paperContracts from '../../migrations/0002_paper_contracts'
import intentRiskClock from '../../migrations/0003_intent_risk_clock'
import deterministicIntents from '../../migrations/0004_deterministic_intents'
import mutationRecovery from '../../migrations/0005_mutation_recovery'
import currentRiskClock from '../../migrations/0006_current_risk_clock'
import accounting from '../../migrations/0007_accounting'
import identifiedSubmitUnknown from '../../migrations/0008_identified_submit_unknown'
import fillSourceTimestamp from '../../migrations/0009_fill_source_timestamp'
import autonomousCycles from '../../migrations/0010_autonomous_cycles'
import causalProtocol from '../../migrations/0011_causal_protocol'
import observeShadowDecisions from '../../migrations/0012_observe_shadow_decisions'
import autonomousCycleTerminalTransitions from '../../migrations/0013_autonomous_cycle_terminal_transitions'
import authorityGenerationHistory from '../../migrations/0014_authority_generation_history'
import acknowledgedSubmitRecovery from '../../migrations/0015_acknowledged_submit_recovery'
import authorityBoundIntents from '../../migrations/0016_authority_bound_intents'
import stableCapitalGrantGeneration from '../../migrations/0017_stable_paper_authority_generation'
import robustTrendProtocol from '../../migrations/0018_robust_trend_protocol'
import explicitExecutionAuthority from '../../migrations/0019_explicit_execution_authority'
import pretransmitSubmitDenial from '../../migrations/0020_pretransmit_submit_denial'
import expiredPaperCycleTerminalization from '../../migrations/0021_expired_paper_cycle_terminalization'
import observeReconciliationRecovery from '../../migrations/0022_observe_reconciliation_recovery'
import legacyObserveRecovery from '../../migrations/0023_legacy_observe_recovery'
import paperCycleClosures from '../../migrations/0024_paper_cycle_closures'
import forwardPerformanceReceipts from '../../migrations/0025_forward_performance_receipts'
import paperCycleCloseReplans from '../../migrations/0026_paper_cycle_close_replans'
import distinctCloseReplanIntents from '../../migrations/0027_distinct_close_replan_intents'
import researchPaperGrants from '../../migrations/0028_research_paper_grants'
import unusedResearchPaperRearm from '../../migrations/0029_unused_research_paper_rearm'
import clearUnusedResearchPaperRearm from '../../migrations/0030_clear_unused_research_paper_rearm'
import blockedPaperGenerationRollover from '../../migrations/0031_blocked_paper_generation_rollover'
import lifecycleCommands from '../../migrations/0032_lifecycle_commands'
import lifecycleCommandNotDueReason from '../../migrations/0033_lifecycle_command_not_due_reason'

export const migrationLoader = PgMigrator.fromRecord({
  '1_initial_schema': initialSchema,
  '2_paper_contracts': paperContracts,
  '3_intent_risk_clock': intentRiskClock,
  '4_deterministic_intents': deterministicIntents,
  '5_mutation_recovery': mutationRecovery,
  '6_current_risk_clock': currentRiskClock,
  '7_accounting': accounting,
  '8_identified_submit_unknown': identifiedSubmitUnknown,
  '9_fill_source_timestamp': fillSourceTimestamp,
  '10_autonomous_cycles': autonomousCycles,
  '11_causal_protocol': causalProtocol,
  '12_observe_shadow_decisions': observeShadowDecisions,
  '13_autonomous_cycle_terminal_transitions': autonomousCycleTerminalTransitions,
  '14_authority_generation_history': authorityGenerationHistory,
  '15_acknowledged_submit_recovery': acknowledgedSubmitRecovery,
  '16_authority_bound_intents': authorityBoundIntents,
  '17_stable_paper_authority_generation': stableCapitalGrantGeneration,
  '18_robust_trend_protocol': robustTrendProtocol,
  '19_explicit_execution_authority': explicitExecutionAuthority,
  '20_pretransmit_submit_denial': pretransmitSubmitDenial,
  '21_expired_paper_cycle_terminalization': expiredPaperCycleTerminalization,
  '22_observe_reconciliation_recovery': observeReconciliationRecovery,
  '23_legacy_observe_recovery': legacyObserveRecovery,
  '24_paper_cycle_closures': paperCycleClosures,
  '25_forward_performance_receipts': forwardPerformanceReceipts,
  '26_paper_cycle_close_replans': paperCycleCloseReplans,
  '27_distinct_close_replan_intents': distinctCloseReplanIntents,
  '28_research_paper_grants': researchPaperGrants,
  '29_unused_research_paper_rearm': unusedResearchPaperRearm,
  '30_clear_unused_research_paper_rearm': clearUnusedResearchPaperRearm,
  '31_blocked_paper_generation_rollover': blockedPaperGenerationRollover,
  '32_lifecycle_commands': lifecycleCommands,
  '33_lifecycle_command_not_due_reason': lifecycleCommandNotDueReason,
})
