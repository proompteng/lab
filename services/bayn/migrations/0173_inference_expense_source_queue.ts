import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE FUNCTION inference_expense_source_needs_quotes(source_request_id text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT count(DISTINCT quote.provider_stage) < CASE
        WHEN request.schema_version='bayn.jev-evaluation-request.v3' AND resolution.request_id IS NULL THEN
          (SELECT count(*) FROM jev_staged_dispatch_claims WHERE request_id=request.request_id) +
          (SELECT count(*) FROM jev_staged_skip_receipts WHERE request_id=request.request_id)
        WHEN request.schema_version='bayn.jev-evaluation-request.v3' THEN 3
        WHEN chart_claim.request_id IS NOT NULL AND resolution.request_id IS NULL THEN 1
        WHEN request.schema_version='bayn.jev-evaluation-request.v2' THEN 2 ELSE 1 END
      FROM jev_evaluation_requests AS request
      LEFT JOIN jev_evaluation_resolutions AS resolution ON resolution.request_id = request.request_id
      LEFT JOIN jev_evaluation_receipts AS receipt ON receipt.request_id = request.request_id
      LEFT JOIN jev_inference_handoffs AS handoff ON handoff.request_id = request.request_id
      LEFT JOIN jev_chart_dispatch_claims AS chart_claim ON chart_claim.request_id = request.request_id
      LEFT JOIN jev_chart_terminal_receipts AS chart_terminal ON chart_terminal.request_id = request.request_id
      LEFT JOIN inference_expense_quotes AS quote ON quote.request_id = request.request_id
        AND quote.handoff_hash IS NOT DISTINCT FROM CASE
          WHEN request.schema_version='bayn.jev-evaluation-request.v3' AND (
            EXISTS (SELECT 1 FROM jev_staged_dispatch_claims WHERE request_id=request.request_id AND stage=quote.provider_stage)
            OR EXISTS (SELECT 1 FROM jev_staged_skip_receipts WHERE request_id=request.request_id AND stage=quote.provider_stage)) THEN NULL
          WHEN quote.provider_stage='CHART' AND chart_claim.request_id IS NOT NULL THEN NULL ELSE handoff.handoff_hash END
        AND quote.chart_claim_hash IS NOT DISTINCT FROM CASE WHEN quote.provider_stage='CHART' THEN chart_claim.claim_hash ELSE NULL END
        AND quote.chart_terminal_hash IS NOT DISTINCT FROM CASE WHEN quote.provider_stage='CHART' THEN chart_terminal.terminal_hash ELSE NULL END
        AND quote.stage_claim_hash IS NOT DISTINCT FROM CASE WHEN request.schema_version='bayn.jev-evaluation-request.v3'
          THEN (SELECT claim_hash FROM jev_staged_dispatch_claims WHERE request_id=request.request_id AND stage=quote.provider_stage) ELSE NULL END
        AND quote.stage_terminal_hash IS NOT DISTINCT FROM CASE WHEN request.schema_version='bayn.jev-evaluation-request.v3'
          THEN (SELECT terminal_hash FROM jev_staged_terminal_receipts WHERE request_id=request.request_id AND stage=quote.provider_stage) ELSE NULL END
        AND quote.stage_skip_hash IS NOT DISTINCT FROM CASE WHEN request.schema_version='bayn.jev-evaluation-request.v3'
          THEN (SELECT skip_hash FROM jev_staged_skip_receipts WHERE request_id=request.request_id AND stage=quote.provider_stage) ELSE NULL END
        AND quote.receipt_hash IS NOT DISTINCT FROM CASE
          WHEN request.schema_version='bayn.jev-evaluation-request.v3' AND (
            EXISTS (SELECT 1 FROM jev_staged_dispatch_claims WHERE request_id=request.request_id AND stage=quote.provider_stage)
            OR EXISTS (SELECT 1 FROM jev_staged_skip_receipts WHERE request_id=request.request_id AND stage=quote.provider_stage)) THEN NULL
          WHEN quote.provider_stage='CHART' AND chart_claim.request_id IS NOT NULL THEN NULL
          WHEN request.schema_version='bayn.jev-evaluation-request.v3' AND quote.provider_stage IN ('CHART','BASE_START')
            AND NOT COALESCE(receipt.payload #>> '{outcome,failure}' = 'NOT_DISPATCHED', false) THEN NULL
          WHEN quote.provider_stage = 'CHART' AND NOT COALESCE(receipt.payload #>> '{outcome,failure}' = 'NOT_DISPATCHED', false) THEN NULL
          WHEN quote.provider_stage = 'JEV' AND handoff.handoff_hash IS NOT NULL AND handoff.payload #>> '{disposition,status}' <> 'READY' THEN NULL
          ELSE receipt.receipt_hash END
      WHERE request.request_id = source_request_id AND (resolution.request_id IS NOT NULL OR chart_claim.request_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM jev_staged_dispatch_claims WHERE request_id=request.request_id)
          OR EXISTS (SELECT 1 FROM jev_staged_skip_receipts WHERE request_id=request.request_id))
      GROUP BY request.request_id, request.schema_version, resolution.request_id, chart_claim.request_id
    ), false)
  $$`
  // Revisions come from a sequence so deletion/re-enqueue cannot reuse an observed revision.
  yield* sql`CREATE SEQUENCE inference_expense_source_revision`
  yield* sql`CREATE TABLE inference_expense_source_pending (
    request_id text PRIMARY KEY REFERENCES jev_evaluation_requests(request_id),
    revision bigint NOT NULL DEFAULT nextval('inference_expense_source_revision') CHECK (revision > 0)
  )`
  yield* sql`CREATE FUNCTION enqueue_inference_expense_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO inference_expense_source_pending(request_id) VALUES (NEW.request_id)
      ON CONFLICT(request_id) DO UPDATE SET revision = nextval('inference_expense_source_revision');
      RETURN NEW;
    END;
  $$`
  yield* sql`CREATE TRIGGER enqueue_inference_expense_source AFTER INSERT ON jev_evaluation_resolutions
    FOR EACH ROW EXECUTE FUNCTION enqueue_inference_expense_source()`
  yield* sql`CREATE TRIGGER enqueue_inference_expense_source AFTER INSERT ON jev_evaluation_receipts
    FOR EACH ROW EXECUTE FUNCTION enqueue_inference_expense_source()`
  yield* sql`CREATE TRIGGER enqueue_inference_expense_source AFTER INSERT ON jev_inference_handoffs
    FOR EACH ROW EXECUTE FUNCTION enqueue_inference_expense_source()`
  yield* sql`CREATE TRIGGER enqueue_inference_expense_source AFTER INSERT ON jev_chart_dispatch_claims
    FOR EACH ROW EXECUTE FUNCTION enqueue_inference_expense_source()`
  yield* sql`CREATE TRIGGER enqueue_inference_expense_source AFTER INSERT ON jev_chart_terminal_receipts
    FOR EACH ROW EXECUTE FUNCTION enqueue_inference_expense_source()`
  yield* sql`CREATE TRIGGER enqueue_inference_expense_source AFTER INSERT ON jev_staged_dispatch_claims
    FOR EACH ROW EXECUTE FUNCTION enqueue_inference_expense_source()`
  yield* sql`CREATE TRIGGER enqueue_inference_expense_source AFTER INSERT ON jev_staged_terminal_receipts
    FOR EACH ROW EXECUTE FUNCTION enqueue_inference_expense_source()`
  yield* sql`CREATE TRIGGER enqueue_inference_expense_source AFTER INSERT ON jev_staged_skip_receipts
    FOR EACH ROW EXECUTE FUNCTION enqueue_inference_expense_source()`
  // One historical metadata pass; subsequent discovery touches only changed sources.
  yield* sql`INSERT INTO inference_expense_source_pending(request_id)
    SELECT request_id FROM jev_evaluation_requests
    WHERE inference_expense_source_needs_quotes(request_id)`
})
