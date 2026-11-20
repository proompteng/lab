import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Only prospective admission changes. Stored policies, grants, decisions and turnover remain immutable.
  yield* sql`DO $migration$
  DECLARE admission text; previous text; replacement text;
  BEGIN
    SELECT pg_get_functiondef('admit_system_qualification_registration()'::regprocedure) INTO STRICT admission;
    previous := $previous$AND policy #>> '{riskPolicy,schemaVersion}' = 'bayn.execution-risk-policy.v4'
      AND (policy #>> '{riskPolicy,maxOrderNotionalMicros}')::numeric BETWEEN 0 AND 40000000000
      AND (policy #>> '{riskPolicy,maxSymbolExposureMicros}')::numeric BETWEEN 0 AND 40000000000
      AND (policy #>> '{riskPolicy,maxGrossExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxNetExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric BETWEEN 0 AND 1000000000000
      AND (policy #>> '{riskPolicy,maxDailyLossMicros}')::numeric BETWEEN 0 AND 5000000000
      AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric BETWEEN 0 AND 10000000000
      AND (((policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric = 200000000000 AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 5000000000)
        OR ((policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric = 1000000000000 AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 10000000000))$previous$;
    replacement := $replacement$AND (policy #>> '{riskPolicy,maxOrderNotionalMicros}')::numeric BETWEEN 0 AND 40000000000
      AND (policy #>> '{riskPolicy,maxSymbolExposureMicros}')::numeric BETWEEN 0 AND 40000000000
      AND (policy #>> '{riskPolicy,maxGrossExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxNetExposureMicros}')::numeric BETWEEN 0 AND 100000000000
      AND (policy #>> '{riskPolicy,maxDailyLossMicros}')::numeric BETWEEN 0 AND 5000000000
      AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric BETWEEN 0 AND 10000000000
      AND ((policy #>> '{riskPolicy,schemaVersion}' = 'bayn.execution-risk-policy.v4'
        AND (((policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric = 200000000000 AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 5000000000)
          OR ((policy #>> '{riskPolicy,maxDailyTradedNotionalMicros}')::numeric = 1000000000000 AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 10000000000)))
        OR (policy #>> '{riskPolicy,schemaVersion}' = 'bayn.execution-risk-policy.v5'
          AND policy #> '{riskPolicy,maxDailyTradedNotionalMicros}' = 'null'::jsonb
          AND (policy #>> '{riskPolicy,maxDrawdownMicros}')::numeric = 10000000000))$replacement$;
    IF strpos(admission, previous) = 0 THEN
      RAISE EXCEPTION 'unexpected prior qualification risk policy';
    END IF;
    EXECUTE replace(admission, previous, replacement);
  END $migration$`
})
