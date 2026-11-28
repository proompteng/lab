import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TRIGGER execution_controller_status_transition ON execution_controller_status`
  // An unchanged update lets the retention trigger witness committed evidence without appending another observation.
  yield* sql`CREATE TRIGGER execution_controller_status_transition
    BEFORE UPDATE ON execution_controller_status
    FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION enforce_execution_controller_status_transition()`
  yield* sql`CREATE TRIGGER execution_controller_status_reject_delete
    BEFORE DELETE ON execution_controller_status
    FOR EACH ROW EXECUTE FUNCTION enforce_execution_controller_status_transition()`
})
