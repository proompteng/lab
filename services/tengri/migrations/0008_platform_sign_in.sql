BEGIN;
ALTER TABLE tengri.schema_version DROP CONSTRAINT schema_version_version_check;
ALTER TABLE tengri.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version BETWEEN 1 AND 8);
DROP FUNCTION tengri.begin_oauth(bytea,bytea,text,text,uuid);
DROP TABLE tengri.oauth_attempts;
REVOKE ALL ON SCHEMA tengri FROM tengri_bff;
REVOKE ALL ON tengri.schema_version FROM tengri_bff;
REVOKE ALL ON FUNCTION tengri.now_ms() FROM tengri_bff;
COMMIT;
