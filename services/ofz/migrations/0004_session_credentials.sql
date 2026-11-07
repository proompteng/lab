ALTER TABLE ofz.platform_schema_version DROP CONSTRAINT platform_schema_version_version_check;
ALTER TABLE ofz.platform_schema_version ADD CHECK (version IN (1, 2, 3));

CREATE TABLE ofz.session_credentials (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    session_id uuid NOT NULL REFERENCES ofz.sessions(id),
    operation_id uuid UNIQUE NOT NULL,
    establishment_fingerprint bytea NOT NULL CHECK (octet_length(establishment_fingerprint) = 32),
    revoked boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX session_credentials_active ON ofz.session_credentials(session_id) WHERE NOT revoked;

INSERT INTO ofz.session_credentials(token_hash,session_id,operation_id,establishment_fingerprint,revoked)
    SELECT token_hash,id,operation_id,establishment_fingerprint,revoked FROM ofz.sessions;
ALTER TABLE ofz.sessions DROP COLUMN token_hash, DROP COLUMN operation_id, DROP COLUMN establishment_fingerprint;

REVOKE ALL ON ofz.session_credentials FROM PUBLIC;
GRANT SELECT, INSERT ON ofz.session_credentials TO ofz_api;
GRANT UPDATE (revoked) ON ofz.session_credentials TO ofz_api;
