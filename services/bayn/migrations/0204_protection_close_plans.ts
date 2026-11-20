import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE protection_release_close_plans (
    proof_id text PRIMARY KEY REFERENCES protection_release_proofs(proof_id) ON DELETE RESTRICT,
    cycle_id text NOT NULL REFERENCES autonomous_cycles(cycle_id) ON DELETE RESTRICT,
    document jsonb NOT NULL CHECK (
      document->>'cycleId' IS NOT DISTINCT FROM cycle_id
      AND document #>> '{document,plannerInput,protectionClose,proofId}' IS NOT DISTINCT FROM proof_id
    )
  )`
  yield* sql`CREATE TRIGGER protection_close_plans_append_only BEFORE UPDATE OR DELETE ON protection_release_close_plans
    FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation()`
  yield* sql`CREATE TRIGGER protection_close_plans_no_truncate BEFORE TRUNCATE ON protection_release_close_plans
    FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation()`
  // The closure, approved intent and mutation can commit together. Qualification still requires the
  // exact source document, including the reproducible risk approval, to have been committed earlier.
  yield* sql`CREATE FUNCTION retain_protection_close_decision_admission() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    INSERT INTO execution_decision_admissions(event_id, decision_id)
    SELECT NEW.event_id, plan.document #>> '{document,contentHash}'
    FROM intents AS target
    JOIN autonomous_cycle_paper_closures AS closure USING (cycle_id)
    JOIN protection_release_close_plans AS plan ON plan.cycle_id = target.cycle_id
      AND plan.proof_id = closure.document #>> '{document,plannerInput,protectionClose,proofId}'
      AND plan.document = closure.document
    JOIN risk_decisions AS risk ON risk.intent_id = target.intent_id AND risk.decision_id = target.risk_decision_id
    WHERE target.intent_id = NEW.intent_id AND target.protection IS NULL
      AND plan.document #> '{document,orderedIntentIds}' = jsonb_build_array(target.intent_id)
      AND plan.document #>> '{document,bindings,accountId}' = target.account_id
      AND plan.document #>> '{document,bindings,authorityGenerationHash}' = target.authority_generation_hash
      AND plan.document #>> '{document,bindings,strategyDecisionHash}' = target.decision_hash
      AND plan.document #>> '{document,bindings,policyHash}' = target.policy_hash
      AND plan.document #>> '{document,deltaRisk,0,evaluation,decision,decisionId}' = risk.decision_id
      AND plan.document #>> '{document,deltaRisk,0,evaluation,decision,inputHash}' = risk.input_hash
      AND risk.policy_hash = target.policy_hash
      AND (plan.document #>> '{document,deltaRisk,0,evaluation,decision,decidedAt}')::timestamptz = risk.decided_at
      AND (plan.document #>> '{document,deltaRisk,0,evaluation,decision,expiresAt}')::timestamptz = risk.expires_at
      AND risk.outcome = 'APPROVED' AND risk.decided_at <= NEW.occurred_at AND risk.expires_at > NEW.occurred_at
      AND (plan.document->>'createdAt')::timestamptz <= NEW.occurred_at
      AND system_evidence_source_committed(plan.xmin)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
  END $function$`
  yield* sql`CREATE TRIGGER retain_protection_close_decision_admission AFTER INSERT ON mutation_events
    FOR EACH ROW WHEN (NEW.event_type = 'SUBMIT_STARTED')
    EXECUTE FUNCTION retain_protection_close_decision_admission()`
})
