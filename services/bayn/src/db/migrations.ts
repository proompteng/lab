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
})
