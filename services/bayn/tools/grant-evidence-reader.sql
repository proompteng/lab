\set ON_ERROR_STOP on
BEGIN;
ALTER ROLE bayn_evidence SET default_transaction_read_only = on;
ALTER ROLE bayn_evidence SET statement_timeout = '10s';
ALTER ROLE bayn_evidence SET lock_timeout = '1s';
GRANT CONNECT ON DATABASE bayn TO bayn_evidence;
GRANT USAGE ON SCHEMA public TO bayn_evidence;
GRANT SELECT ON
  native_arrival_epochs,
  native_arrival_chunks,
  native_arrival_ends,
  autonomous_cycles,
  intraday_candidate_observations,
  jev_batch_plans,
  jev_batch_results,
  autonomous_cycle_shadow_decisions,
  jev_evaluation_requests,
  jev_evaluation_receipts,
  jev_evaluation_resolutions,
  inference_expense_quotes
TO bayn_evidence;
COMMIT;
