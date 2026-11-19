DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM ofz.platform_commands WHERE NOT completed) THEN
        RAISE EXCEPTION 'complete platform commands before provider connection migration';
    END IF;
END $$;
ALTER TABLE ofz.platform_schema_version DROP CONSTRAINT platform_schema_version_version_check;
ALTER TABLE ofz.platform_schema_version ADD CHECK (version IN (1, 2, 3, 4, 5, 6, 7, 8));

CREATE TABLE ofz.provider_connections (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    profile_id text NOT NULL,
    owner_id text NOT NULL,
    client_service text NOT NULL,
    profile_hash bytea NOT NULL CHECK (octet_length(profile_hash)=32),
    state text NOT NULL CHECK (state IN ('disconnected','ready','reconnect','refreshing')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    account jsonb,
    credential bytea CHECK (octet_length(credential) BETWEEN 28 AND 65536),
    expires_at_ms bigint,
    updated_at_ms bigint NOT NULL DEFAULT ofz.now_ms(),
    UNIQUE (workspace_id,profile_id,owner_id,client_service)
);
CREATE UNLOGGED TABLE ofz.provider_attempts (
    operation_id uuid PRIMARY KEY,
    connection_id uuid NOT NULL REFERENCES ofz.provider_connections(id),
    workload_id text NOT NULL,
    human_id text NOT NULL,
    profile_hash bytea NOT NULL CHECK (octet_length(profile_hash)=32),
    state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash)=32),
    binding_hash bytea NOT NULL CHECK (octet_length(binding_hash)=32),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint)=32),
    sealed bytea NOT NULL CHECK (octet_length(sealed) BETWEEN 28 AND 65536),
    expected_revision bigint NOT NULL,
    phase text NOT NULL CHECK (phase IN ('pending','exchanging','complete','failed','cancelled')),
    code_hash bytea,
    problem integer NOT NULL DEFAULT 0 CHECK (problem BETWEEN 0 AND 4),
    expires_at_ms bigint NOT NULL
);
CREATE INDEX provider_attempt_expiry ON ofz.provider_attempts(expires_at_ms);
CREATE INDEX provider_attempt_owner ON ofz.provider_attempts(human_id,expires_at_ms);
CREATE TABLE ofz.provider_disconnects (
    operation_id uuid PRIMARY KEY,
    workload_id text NOT NULL,
    human_id text NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint)=32),
    connection_id uuid NOT NULL,
    decision jsonb NOT NULL,
    provider_revocation_confirmed boolean NOT NULL DEFAULT false
);
REVOKE ALL ON ofz.provider_connections,ofz.provider_attempts,ofz.provider_disconnects FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON ofz.provider_connections,ofz.provider_attempts,ofz.provider_disconnects TO ofz_api;
GRANT DELETE ON ofz.provider_attempts TO ofz_api;

ALTER TABLE ofz.platform_executions
    ADD COLUMN provider_connection_id uuid REFERENCES ofz.provider_connections(id),
    ADD COLUMN provider_credential_revision bigint;
GRANT UPDATE (provider_connection_id,provider_credential_revision) ON ofz.platform_executions TO ofz_api;
