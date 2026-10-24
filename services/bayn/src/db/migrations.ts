import marketHoldingHorizons from '../../migrations/0144_market_holding_horizons'
import executableProfitLimits from '../../migrations/0143_executable_profit_limits'
import nativeArrivalAppendLocality from '../../migrations/0142_native_arrival_append_locality'
import fundedPlanCoverage from '../../migrations/0141_funded_plan_coverage'
import economicTradePlans from '../../migrations/0140_economic_trade_plans'
import jevGepaEditor from '../../migrations/0139_jev_gepa_editor'
import jevEditorStructuredOutput from '../../migrations/0138_jev_editor_structured_output'
import setupAndPlan from '../../migrations/0137_setup_and_plan'
import currentAuthorityWrites from '../../migrations/0136_current_authority_writes'
import jevEditorIdentity from '../../migrations/0135_jev_editor_identity'
import completePlanChoice from '../../migrations/0133_complete_plan_choice'
import removeUnusedSchema from '../../migrations/0134_remove_unused_schema'
import jevHarness2 from '../../migrations/0132_jev_harness2'
import modelSelectedTradePlan from '../../migrations/0131_model_selected_trade_plan'
import feeSourceCreatedAt from '../../migrations/0130_fee_source_created_at'
import harness2Research from '../../migrations/0129_harness2_research'
import strategyNativeProtection from '../../migrations/0128_strategy_native_protection'
import currentJevCycles from '../../migrations/0127_current_jev_cycles'
import entryBoundExits from '../../migrations/0126_entry_bound_exits'
import marketManagementJudgment from '../../migrations/0125_market_management_judgment'
import focusedJevJudgments from '../../migrations/0124_focused_jev_judgments'
import setupActionProtocol from '../../migrations/0123_setup_action_protocol'
import explicitLimitDecisions from '../../migrations/0122_explicit_limit_decisions'
import explicitLimitIntents from '../../migrations/0121_explicit_limit_intents'
import mixedMarketReplay from '../../migrations/0120_mixed_market_replay'
import nativeArrivalRetention from '../../migrations/0119_native_arrival_retention'
import completedBarBenchmarks from '../../migrations/0118_completed_bar_benchmarks'
import riskValuationIndexes from '../../migrations/0117_risk_valuation_indexes'
import costSupportedEntry from '../../migrations/0116_cost_supported_entry'
import requiredPositionCost from '../../migrations/0115_required_position_cost'
import limitOrderCompletion from '../../migrations/0114_limit_order_completion'
import extendedEquityHours from '../../migrations/0113_extended_equity_hours'
import shadowDecisionGenerationIndex from '../../migrations/0104_shadow_decision_generation_index'
import reclassifyExpiredNativeEntry from '../../migrations/0101_reclassify_expired_native_entry'
import unusedEntryAdmission from '../../migrations/0100_unused_entry_admission'
import submissionDenialReason from '../../migrations/0099_submission_denial_reason'
import valkeyBrokerMaterializations from '../../migrations/0098_valkey_broker_materializations'
import brokerObservationQuota from '../../migrations/0096_broker_observation_quota'
import continuousCashSpot from '../../migrations/0097_continuous_cash_spot'
import completionEvidenceIndexes from '../../migrations/0095_completion_evidence_indexes'
import brokerObservationCaptures from '../../migrations/0094_broker_observation_captures'
import researchInference from '../../migrations/0093_research_inference'
import expiredZeroExecutionRearm from '../../migrations/0092_expired_zero_execution_rearm'
import inferenceExpenseQuotes from '../../migrations/0091_inference_expense_quotes'
import momentumFirstJevCompatibility from '../../migrations/0090_momentum_first_jev_compatibility'
import researchCapture from '../../migrations/0089_research_capture'
import preserveReconciliationRearmCycle from '../../migrations/0088_preserve_reconciliation_rearm_cycle'
import brokerObservations from '../../migrations/0087_broker_observations'
import executionWaitingStatus from '../../migrations/0074_execution_waiting_status'
import candidateObservations from '../../migrations/0075_candidate_observations'
import jevEvaluationEvidence from '../../migrations/0076_jev_evaluation_evidence'
import jevEvaluationResolution from '../../migrations/0077_jev_evaluation_resolution'
import jevBatches from '../../migrations/0078_jev_batches'
import jevNativeStrategy from '../../migrations/0079_jev_native_strategy'
import jevExitCommitDeadline from '../../migrations/0080_jev_exit_commit_deadline'
import measuredSimulationClock from '../../migrations/0081_measured_simulation_clock'
import openSessionFailureRearm from '../../migrations/0082_open_session_failure_rearm'
import jevEntryBatchPlanV2 from '../../migrations/0083_jev_entry_batch_plan_v2'
import jevEntryBatchPlanV3 from '../../migrations/0084_jev_entry_batch_plan_v3'
import replaySourceClock from '../../migrations/0085_replay_source_clock'
import settledObserveRecovery from '../../migrations/0086_settled_observe_recovery'
import recoverIntradayAuthorityCycle from '../../migrations/0071_recover_intraday_authority_cycle'
import intradayZeroFillRearm from '../../migrations/0072_intraday_zero_fill_rearm'
import pacedIntradayEntryAttempts from '../../migrations/0073_paced_intraday_entry_attempts'
import simulatedBrokerCheckpoints from '../../migrations/0070_simulated_broker_checkpoints'
import simulatedExecutionClock from '../../migrations/0069_simulated_execution_clock'
import simulatedSnapshotReferences from '../../migrations/0068_simulated_snapshot_references'
import positionCostBasis from '../../migrations/0067_position_cost_basis'
import streamingAuthorityProtocol from '../../migrations/0066_streaming_authority_protocol'
import streamingSnapshotReferences from '../../migrations/0065_streaming_snapshot_references'
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
import researchCapitalGrants from '../../migrations/0028_research_paper_grants'
import unusedResearchPaperRearm from '../../migrations/0029_unused_research_paper_rearm'
import clearUnusedResearchPaperRearm from '../../migrations/0030_clear_unused_research_paper_rearm'
import blockedPaperGenerationRollover from '../../migrations/0031_blocked_paper_generation_rollover'
import lifecycleCommands from '../../migrations/0032_lifecycle_commands'
import lifecycleCommandNotDueReason from '../../migrations/0033_lifecycle_command_not_due_reason'
import terminalPaperGenerationRollover from '../../migrations/0034_terminal_paper_generation_rollover'
import notionalMarketOrders from '../../migrations/0035_notional_market_orders'
import qualifiedCycleSnapshotBinding from '../../migrations/0036_qualified_cycle_snapshot_binding'
import accountNeutralRuntimeCompatibility from '../../migrations/0037_account_neutral_runtime_compatibility'
import accountNeutralCapitalGrants from '../../migrations/0038_account_neutral_capital_grants'
import accountNeutralAuthorityTerminalization from '../../migrations/0039_account_neutral_authority_terminalization'
import executionControllerStatus from '../../migrations/0040_execution_controller_status'
import executionControllerActiveStatus from '../../migrations/0041_execution_controller_active_status'
import executionControllerPlanStatus from '../../migrations/0042_execution_controller_plan_status'
import executionControllerActivationProjection from '../../migrations/0043_execution_controller_activation_projection'
import executionControllerPassObservation from '../../migrations/0044_execution_controller_pass_observation'
import intradayAutonomousCycles from '../../migrations/0045_intraday_autonomous_cycles'
import intradayNativeCycles from '../../migrations/0046_intraday_native_cycles'
import openingDriveQualificationEvidence from '../../migrations/0047_opening_drive_qualification_evidence'
import researchReconciliationRearm from '../../migrations/0048_research_reconciliation_rearm'
import preserveReconciliationCycle from '../../migrations/0049_preserve_reconciliation_cycle'
import preserveFailureRearmCycle from '../../migrations/0050_preserve_failure_rearm_cycle'
import positionSnapshotIngestionOrder from '../../migrations/0051_position_snapshot_ingestion_order'
import positionSnapshotObservabilityIndex from '../../migrations/0052_position_snapshot_observability_index'
import fullSessionIntradayCycles from '../../migrations/0053_full_session_intraday_cycles'
import benignZeroFillIocCompletion from '../../migrations/0054_benign_zero_fill_ioc_completion'
import intradaySnapshotReferences from '../../migrations/0055_intraday_snapshot_references'
import intradayStrategyCutover from '../../migrations/0056_intraday_strategy_cutover'
import recoverPreopenAuthorityCycle from '../../migrations/0057_recover_preopen_authority_cycle'
import archiveReaderAvailability from '../../migrations/0058_archive_reader_availability'
import regularSessionBoundaries from '../../migrations/0059_regular_session_boundaries'
import materializedCompletionCutoff from '../../migrations/0060_materialized_completion_cutoff'
import latestRearmPosition from '../../migrations/0061_latest_rearm_position'
import discrepancyMandateRotation from '../../migrations/0062_discrepancy_mandate_rotation'
import brokerFeeAccounting from '../../migrations/0063_broker_fee_accounting'
import observedFeeAccruals from '../../migrations/0102_observed_fee_accruals'
import cashFeeOpeningPrecision from '../../migrations/0103_cash_fee_opening_precision'
import cryptoCashFeeSettlement from '../../migrations/0105_crypto_cash_fee_settlement'
import cashFeeOverrelease from '../../migrations/0106_cash_fee_overrelease'
import feePostingAcknowledgements from '../../migrations/0107_fee_posting_acknowledgements'
import availableHistoryProtocol from '../../migrations/0108_available_history_protocol'
import capitalSizingProtocol from '../../migrations/0109_capital_sizing_protocol'
import capitalSizingRecovery from '../../migrations/0110_capital_sizing_recovery'
import modelActionProtocol from '../../migrations/0111_model_action_protocol'
import brokerCashSettlements from '../../migrations/0112_broker_cash_settlements'
import partialIocCompletion from '../../migrations/0064_partial_ioc_completion'

export const migrationLoader = PgMigrator.fromRecord({
  '144_market_holding_horizons': marketHoldingHorizons,
  '143_executable_profit_limits': executableProfitLimits,
  '142_native_arrival_append_locality': nativeArrivalAppendLocality,
  '140_economic_trade_plans': economicTradePlans,
  '141_funded_plan_coverage': fundedPlanCoverage,
  '137_setup_and_plan': setupAndPlan,
  '138_jev_editor_structured_output': jevEditorStructuredOutput,
  '139_jev_gepa_editor': jevGepaEditor,
  '136_current_authority_writes': currentAuthorityWrites,
  '134_remove_unused_schema': removeUnusedSchema,
  '127_current_jev_cycles': currentJevCycles,
  '126_entry_bound_exits': entryBoundExits,
  '128_strategy_native_protection': strategyNativeProtection,
  '135_jev_editor_identity': jevEditorIdentity,
  '132_jev_harness2': jevHarness2,
  '131_model_selected_trade_plan': modelSelectedTradePlan,
  '133_complete_plan_choice': completePlanChoice,
  '129_harness2_research': harness2Research,
  '130_fee_source_created_at': feeSourceCreatedAt,
  '123_setup_action_protocol': setupActionProtocol,
  '124_focused_jev_judgments': focusedJevJudgments,
  '125_market_management_judgment': marketManagementJudgment,
  '122_explicit_limit_decisions': explicitLimitDecisions,
  '121_explicit_limit_intents': explicitLimitIntents,
  '120_mixed_market_replay': mixedMarketReplay,
  '119_native_arrival_retention': nativeArrivalRetention,
  '118_completed_bar_benchmarks': completedBarBenchmarks,
  '117_risk_valuation_indexes': riskValuationIndexes,
  '116_cost_supported_entry': costSupportedEntry,
  '115_required_position_cost': requiredPositionCost,
  '114_limit_order_completion': limitOrderCompletion,
  '113_extended_equity_hours': extendedEquityHours,
  '112_broker_cash_settlements': brokerCashSettlements,
  '111_model_action_protocol': modelActionProtocol,
  '109_capital_sizing_protocol': capitalSizingProtocol,
  '110_capital_sizing_recovery': capitalSizingRecovery,
  '107_fee_posting_acknowledgements': feePostingAcknowledgements,
  '108_available_history_protocol': availableHistoryProtocol,
  '106_cash_fee_overrelease': cashFeeOverrelease,
  '104_shadow_decision_generation_index': shadowDecisionGenerationIndex,
  '105_crypto_cash_fee_settlement': cryptoCashFeeSettlement,
  '103_cash_fee_opening_precision': cashFeeOpeningPrecision,
  '102_observed_fee_accruals': observedFeeAccruals,
  '101_reclassify_expired_native_entry': reclassifyExpiredNativeEntry,
  '100_unused_entry_admission': unusedEntryAdmission,
  '99_submission_denial_reason': submissionDenialReason,
  '98_valkey_broker_materializations': valkeyBrokerMaterializations,
  '96_broker_observation_quota': brokerObservationQuota,
  '97_continuous_cash_spot': continuousCashSpot,
  '95_completion_evidence_indexes': completionEvidenceIndexes,
  '94_broker_observation_captures': brokerObservationCaptures,
  '93_research_inference': researchInference,
  '92_expired_zero_execution_rearm': expiredZeroExecutionRearm,
  '91_inference_expense_quotes': inferenceExpenseQuotes,
  '90_momentum_first_jev_compatibility': momentumFirstJevCompatibility,
  '89_research_capture': researchCapture,
  '88_preserve_reconciliation_rearm_cycle': preserveReconciliationRearmCycle,
  '87_broker_observations': brokerObservations,
  '86_settled_observe_recovery': settledObserveRecovery,
  '84_jev_entry_batch_plan_v3': jevEntryBatchPlanV3,
  '85_replay_source_clock': replaySourceClock,
  '83_jev_entry_batch_plan_v2': jevEntryBatchPlanV2,
  '82_open_session_failure_rearm': openSessionFailureRearm,
  '81_measured_simulation_clock': measuredSimulationClock,
  '80_jev_exit_commit_deadline': jevExitCommitDeadline,
  '79_jev_native_strategy': jevNativeStrategy,
  '78_jev_batches': jevBatches,
  '77_jev_evaluation_resolution': jevEvaluationResolution,
  '76_jev_evaluation_evidence': jevEvaluationEvidence,
  '67_position_cost_basis': positionCostBasis,
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
  '28_research_paper_grants': researchCapitalGrants,
  '29_unused_research_paper_rearm': unusedResearchPaperRearm,
  '30_clear_unused_research_paper_rearm': clearUnusedResearchPaperRearm,
  '31_blocked_paper_generation_rollover': blockedPaperGenerationRollover,
  '32_lifecycle_commands': lifecycleCommands,
  '33_lifecycle_command_not_due_reason': lifecycleCommandNotDueReason,
  '34_terminal_paper_generation_rollover': terminalPaperGenerationRollover,
  '35_notional_market_orders': notionalMarketOrders,
  '36_qualified_cycle_snapshot_binding': qualifiedCycleSnapshotBinding,
  '37_account_neutral_runtime_compatibility': accountNeutralRuntimeCompatibility,
  '38_account_neutral_capital_grants': accountNeutralCapitalGrants,
  '39_account_neutral_authority_terminalization': accountNeutralAuthorityTerminalization,
  '40_execution_controller_status': executionControllerStatus,
  '41_execution_controller_active_status': executionControllerActiveStatus,
  '42_execution_controller_plan_status': executionControllerPlanStatus,
  '43_execution_controller_activation_projection': executionControllerActivationProjection,
  '44_execution_controller_pass_observation': executionControllerPassObservation,
  '45_intraday_autonomous_cycles': intradayAutonomousCycles,
  '46_intraday_native_cycles': intradayNativeCycles,
  '47_opening_drive_qualification_evidence': openingDriveQualificationEvidence,
  '48_research_reconciliation_rearm': researchReconciliationRearm,
  '49_preserve_reconciliation_cycle': preserveReconciliationCycle,
  '50_preserve_failure_rearm_cycle': preserveFailureRearmCycle,
  '51_position_snapshot_ingestion_order': positionSnapshotIngestionOrder,
  '52_position_snapshot_observability_index': positionSnapshotObservabilityIndex,
  '53_full_session_intraday_cycles': fullSessionIntradayCycles,
  '54_benign_zero_fill_ioc_completion': benignZeroFillIocCompletion,
  '55_intraday_snapshot_references': intradaySnapshotReferences,
  '56_intraday_strategy_cutover': intradayStrategyCutover,
  '57_recover_preopen_authority_cycle': recoverPreopenAuthorityCycle,
  '58_archive_reader_availability': archiveReaderAvailability,
  '59_regular_session_boundaries': regularSessionBoundaries,
  '60_materialized_completion_cutoff': materializedCompletionCutoff,
  '61_latest_rearm_position': latestRearmPosition,
  '62_discrepancy_mandate_rotation': discrepancyMandateRotation,
  '63_broker_fee_accounting': brokerFeeAccounting,
  '64_partial_ioc_completion': partialIocCompletion,
  '65_streaming_snapshot_references': streamingSnapshotReferences,
  '68_simulated_snapshot_references': simulatedSnapshotReferences,
  '69_simulated_execution_clock': simulatedExecutionClock,
  '70_simulated_broker_checkpoints': simulatedBrokerCheckpoints,
  '66_streaming_authority_protocol': streamingAuthorityProtocol,
  '71_recover_intraday_authority_cycle': recoverIntradayAuthorityCycle,
  '72_intraday_zero_fill_rearm': intradayZeroFillRearm,
  '73_paced_intraday_entry_attempts': pacedIntradayEntryAttempts,
  '74_execution_waiting_status': executionWaitingStatus,
  '75_candidate_observations': candidateObservations,
})
