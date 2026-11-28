BEGIN;
ALTER TABLE tengri.schema_version DROP CONSTRAINT schema_version_version_check;
ALTER TABLE tengri.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version BETWEEN 1 AND 7);

ALTER TABLE tengri.oauth_attempts SET UNLOGGED;
COMMIT;
