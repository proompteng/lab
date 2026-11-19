import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Change only new registration identity. Existing attempts, receipts and authority limits remain immutable.
  yield* sql`DO $migration$
  DECLARE definition text;
  BEGIN
    SELECT pg_get_functiondef('admit_system_qualification_registration()'::regprocedure) INTO definition;
    IF strpos(definition, '7013c86f0b60da5ccc98cc82e4c9b077c8ab7a5c242f846a598bb77058782635') = 0 THEN
      RAISE EXCEPTION 'unexpected prior registration policy' USING ERRCODE = '23514';
    END IF;
    EXECUTE replace(definition,
      '7013c86f0b60da5ccc98cc82e4c9b077c8ab7a5c242f846a598bb77058782635',
      'bf7c0a91d50457aeac8a3e90d004418ffd8af93e032499baaefbd9aee0f41638');
  END $migration$`
  yield* sql`DO $assessment$
  DECLARE definition text;
  BEGIN
    SELECT pg_get_functiondef('check_system_assessment_scope()'::regprocedure) INTO definition;
    IF strpos(definition, 'RETURN NEW;') = 0 THEN
      RAISE EXCEPTION 'unexpected prior assessment scope guard' USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, 'RETURN NEW;',
      'IF registration.payload_text::jsonb->>''policyHash'' = ''bf7c0a91d50457aeac8a3e90d004418ffd8af93e032499baaefbd9aee0f41638''
        AND (NEW.verdict = ''QUALIFIED_PAPER'' OR NEW.assessment_text::jsonb #>> ''{edge,status}'' = ''ESTABLISHED_UNDER_PROTOCOL'') THEN
        RAISE EXCEPTION ''research bootstrap cannot establish statistical qualification'' USING ERRCODE = ''23514'';
      END IF;
      RETURN NEW;');
  END $assessment$`
})
