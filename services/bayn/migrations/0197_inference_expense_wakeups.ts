import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Notifications are commit-time hints. Existing evidence remains the recovery authority.
  yield* sql`CREATE FUNCTION wake_account_inference_expense() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('bayn_inference_expense_account', '');
      RETURN NULL;
    END;
  $$`
  yield* sql`CREATE FUNCTION wake_research_inference_expense() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_notify('bayn_inference_expense_research', '');
      RETURN NULL;
    END;
  $$`
  yield* sql`CREATE TRIGGER wake_inference_expense_source
    AFTER INSERT OR UPDATE ON inference_expense_source_pending
    FOR EACH STATEMENT EXECUTE FUNCTION wake_account_inference_expense()`
  yield* sql`CREATE TRIGGER wake_inference_expense_quote
    AFTER INSERT ON inference_expense_quotes
    FOR EACH STATEMENT EXECUTE FUNCTION wake_account_inference_expense()`
  yield* sql`CREATE TRIGGER wake_inference_expense_plan
    AFTER INSERT ON jev_batch_plans
    FOR EACH STATEMENT EXECUTE FUNCTION wake_account_inference_expense()`
  yield* sql`CREATE TRIGGER wake_inference_expense_work
    AFTER INSERT ON jev_inference_work
    FOR EACH STATEMENT EXECUTE FUNCTION wake_account_inference_expense()`
  yield* sql`CREATE TRIGGER wake_inference_expense_terminal_cycle
    AFTER INSERT OR UPDATE OF state, terminal_at ON autonomous_cycles
    FOR EACH ROW WHEN (NEW.state IN ('COMPLETED', 'NO_TRADE', 'BLOCKED') AND NEW.terminal_at IS NOT NULL)
    EXECUTE FUNCTION wake_account_inference_expense()`
  yield* sql`CREATE TRIGGER wake_research_inference_expense_receipt
    AFTER INSERT ON research_inference_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION wake_research_inference_expense()`
})
