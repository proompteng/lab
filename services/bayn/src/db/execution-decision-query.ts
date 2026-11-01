import type { PgClient } from '@effect/sql-pg'

/** Immutable entry, closure and residual-close instructions; callers apply their account and window scope. */
export const executionDecisionRows = (sql: PgClient.PgClient) => sql`
            SELECT
              cycle.cycle_id,
              decision.decision_hash,
              decision.document,
              decision.created_at
            FROM autonomous_cycles AS cycle
            JOIN autonomous_cycle_shadow_decisions AS decision
              ON decision.cycle_id = cycle.cycle_id
              AND decision.decision_hash = cycle.decision_hash
            WHERE decision.schema_version IN ('bayn.observe-shadow-decision.v1', 'bayn.paper-cycle-decision.v1', 'bayn.observe-shadow-decision.v2', 'bayn.paper-cycle-decision.v2')
            UNION ALL
            SELECT
              cycle.cycle_id,
              closure.document #>> '{document,contentHash}' AS decision_hash,
              closure.document -> 'document' AS document,
              (closure.document ->> 'createdAt')::timestamptz AS created_at
            FROM autonomous_cycles AS cycle
            JOIN autonomous_cycle_paper_closures AS closure ON closure.cycle_id = cycle.cycle_id
            WHERE closure.document #>> '{document,schemaVersion}' IN ('bayn.paper-cycle-decision.v1', 'bayn.paper-cycle-decision.v2')
            UNION ALL
            SELECT
              cycle.cycle_id,
              replan.document #>> '{document,contentHash}' AS decision_hash,
              replan.document -> 'document' AS document,
              (replan.document ->> 'createdAt')::timestamptz AS created_at
            FROM autonomous_cycles AS cycle
            JOIN autonomous_cycle_paper_close_replans AS replan ON replan.cycle_id = cycle.cycle_id
            WHERE replan.document #>> '{document,schemaVersion}' IN ('bayn.paper-cycle-decision.v1', 'bayn.paper-cycle-decision.v2')
`
