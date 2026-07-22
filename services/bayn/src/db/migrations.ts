import { PgMigrator } from '@effect/sql-pg'

import initialSchema from '../../migrations/0001_initial_schema'
import paperContracts from '../../migrations/0002_paper_contracts'
import intentRiskClock from '../../migrations/0003_intent_risk_clock'
import deterministicIntents from '../../migrations/0004_deterministic_intents'
import mutationRecovery from '../../migrations/0005_mutation_recovery'

export const migrationLoader = PgMigrator.fromRecord({
  '1_initial_schema': initialSchema,
  '2_paper_contracts': paperContracts,
  '3_intent_risk_clock': intentRiskClock,
  '4_deterministic_intents': deterministicIntents,
  '5_mutation_recovery': mutationRecovery,
})
