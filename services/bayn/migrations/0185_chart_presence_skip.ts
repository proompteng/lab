import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DO $migration$
    DECLARE
      definition text;
      prior_predicate text := $predicate$(NEW.payload->>'reason'='NO_BASE' AND selected->>'type'='choice' AND selected->>'choice'='no_base')$predicate$;
      presence_predicate text := $predicate$(NEW.payload->>'reason'='NO_BASE' AND selected->>'type'='choice' AND (
        selected->>'choice'='no_base'
        OR (predecessor #>> '{outcome,inference,response,answers,base_present,type}'='noul'
          AND CASE WHEN jsonb_typeof(predecessor #> '{outcome,inference,response,answers,base_present,noul}')='number'
            THEN (predecessor #>> '{outcome,inference,response,answers,base_present,noul}')::numeric BETWEEN 0 AND 0.30
            ELSE false END)))$predicate$;
    BEGIN
      definition := pg_get_functiondef('enforce_staged_skip_receipt()'::regprocedure);
      IF strpos(definition, '''bayn.jev.protocol.v39''')=0 OR strpos(definition, prior_predicate)=0 THEN
        RAISE EXCEPTION 'unexpected prior chart-presence skip guard' USING ERRCODE='55000';
      END IF;
      EXECUTE replace(definition, prior_predicate, presence_predicate);
    END $migration$`
})
