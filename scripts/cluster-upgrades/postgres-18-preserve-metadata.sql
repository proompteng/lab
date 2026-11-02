\set ON_ERROR_STOP on
SELECT current_setting('server_version_num')::int = 180006
  AND current_database() = :'expected_database'
  AND current_database() IN ('buzz', 'jangar', 'torghut_sim_default')
  AND (SELECT system_identifier::text FROM pg_control_system()) = :'expected_system_id'
  AS correct_target,
  current_database() = 'torghut_sim_default' AS sequence_case
\gset
\if :correct_target
\else
  DO $wrong_target$ BEGIN
    RAISE EXCEPTION 'Refusing metadata repair on an unverified PostgreSQL 18.6 target';
  END $wrong_target$;
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
\if :sequence_case
  DO $sequence_owner$
  BEGIN
    IF (SELECT pg_get_userbyid(relowner) FROM pg_class
        WHERE oid = 'public.torghut_meta_id_seq'::regclass AND relkind = 'S')
        IS DISTINCT FROM 'torghut_app' THEN
      RAISE EXCEPTION 'Unexpected original sequence owner';
    END IF;
  END
  $sequence_owner$;
  SET LOCAL ROLE torghut_app;
  GRANT SELECT, UPDATE ON SEQUENCE public.torghut_meta_id_seq TO torghut_app;
  RESET ROLE;
\else
  DO $extension_owner$
  DECLARE
    extension_name text;
    original_role text;
    extension_id oid;
    original_owner oid;
    current_owner oid;
    database_id oid;
  BEGIN
    CASE current_database()
      WHEN 'buzz' THEN extension_name := 'pgcrypto'; original_role := 'buzz';
      WHEN 'jangar' THEN extension_name := 'pg_trgm'; original_role := 'jangar';
      ELSE RAISE EXCEPTION 'Unexpected metadata repair database';
    END CASE;
    SELECT oid INTO STRICT original_owner FROM pg_roles WHERE rolname = original_role;
    SELECT oid INTO STRICT database_id FROM pg_database WHERE datname = current_database();
    SELECT oid, extowner INTO STRICT extension_id, current_owner
      FROM pg_extension WHERE extname = extension_name;
    IF current_owner NOT IN (10, original_owner) THEN
      RAISE EXCEPTION 'Unexpected extension owner';
    END IF;
    IF EXISTS (SELECT FROM pg_shdepend
        WHERE dbid = database_id AND classid = 'pg_extension'::regclass
          AND objid = extension_id AND deptype = 'o'
          AND (refclassid <> 'pg_authid'::regclass OR refobjid <> original_owner)) THEN
      RAISE EXCEPTION 'Unexpected extension ownership dependency';
    END IF;
    UPDATE pg_extension SET extowner = original_owner
      WHERE oid = extension_id AND extowner <> original_owner;
    INSERT INTO pg_shdepend (dbid, classid, objid, objsubid, refclassid, refobjid, deptype)
      SELECT database_id, 'pg_extension'::regclass, extension_id, 0,
        'pg_authid'::regclass, original_owner, 'o'
      WHERE NOT EXISTS (SELECT FROM pg_shdepend
        WHERE dbid = database_id AND classid = 'pg_extension'::regclass
          AND objid = extension_id AND deptype = 'o');
    IF (SELECT count(*) FROM pg_shdepend
        WHERE dbid = database_id AND classid = 'pg_extension'::regclass
          AND objid = extension_id AND deptype = 'o' AND refobjid = original_owner) <> 1 THEN
      RAISE EXCEPTION 'Original extension ownership dependency was not restored';
    END IF;
  END
  $extension_owner$;
\endif
COMMIT;
