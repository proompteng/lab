ALTER TABLE ofz.platform_schema_version DROP CONSTRAINT platform_schema_version_version_check;
ALTER TABLE ofz.platform_schema_version ADD CHECK (version IN (1, 2, 3, 4, 5));

-- A database failover discards unfinished sign-ins, never established authority.
CREATE UNLOGGED TABLE ofz.sign_in_attempts (
    gateway_service text NOT NULL CHECK (length(gateway_service) BETWEEN 1 AND 128),
    state_hash bytea NOT NULL CHECK (octet_length(state_hash)=32),
    binding_hash bytea NOT NULL CHECK (octet_length(binding_hash)=32),
    verifier text NOT NULL CHECK (length(verifier)=43),
    nonce text NOT NULL CHECK (length(nonce)=43),
    operation_id uuid UNIQUE NOT NULL,
    expires_at_ms bigint NOT NULL,
    PRIMARY KEY (gateway_service, state_hash)
);
CREATE INDEX sign_in_attempt_expiry ON ofz.sign_in_attempts(expires_at_ms);
REVOKE ALL ON ofz.sign_in_attempts FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON ofz.sign_in_attempts TO ofz_api;
