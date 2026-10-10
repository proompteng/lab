BEGIN;
CREATE SCHEMA IF NOT EXISTS ofz;
REVOKE ALL ON SCHEMA ofz FROM PUBLIC;
CREATE TABLE ofz.schema_version (version integer PRIMARY KEY CHECK (version = 1), checksum bytea CHECK (octet_length(checksum) = 32));
INSERT INTO ofz.schema_version(version) VALUES (1);
CREATE FUNCTION ofz.now_ms() RETURNS bigint LANGUAGE sql VOLATILE
AS $$ SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint $$;

CREATE TABLE ofz.platform_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    recovery_generation bigint NOT NULL DEFAULT 1 CHECK (recovery_generation > 0),
    fenced boolean NOT NULL DEFAULT true,
    minimum_administrators integer NOT NULL DEFAULT 2 CHECK (minimum_administrators >= 2),
    fleet_workspaces integer NOT NULL DEFAULT 6 CHECK (fleet_workspaces > 0),
    fleet_active integer NOT NULL DEFAULT 6 CHECK (fleet_active > 0),
    fleet_bytes bigint NOT NULL DEFAULT 206158430208 CHECK (fleet_bytes > 0)
);
INSERT INTO ofz.platform_state DEFAULT VALUES;
CREATE TABLE ofz.memberships (
    human_id text NOT NULL CHECK (human_id ~ '^[0-9a-f]{64}$'),
    role integer NOT NULL CHECK (role BETWEEN 1 AND 4),
    PRIMARY KEY (human_id, role)
);
CREATE TABLE ofz.quotas (
    human_id text PRIMARY KEY CHECK (human_id ~ '^[0-9a-f]{64}$'),
    total_workspaces integer NOT NULL CHECK (total_workspaces BETWEEN 0 AND 6),
    active_workspaces integer NOT NULL CHECK (active_workspaces BETWEEN 0 AND 6 AND active_workspaces <= total_workspaces),
    retained_bytes bigint NOT NULL CHECK (retained_bytes BETWEEN 0 AND 206158430208)
);
CREATE TABLE ofz.reservations (
    id uuid PRIMARY KEY,
    owner_id text NOT NULL CHECK (owner_id ~ '^[0-9a-f]{64}$'),
    home_bytes bigint NOT NULL CHECK (home_bytes = 34359738368),
    created_at_ms bigint NOT NULL DEFAULT ofz.now_ms(),
    state text NOT NULL CHECK (state IN ('reserved', 'enrolled', 'released'))
);
CREATE TABLE ofz.workspaces (
    uid uuid PRIMARY KEY,
    owner_id text NOT NULL CHECK (owner_id ~ '^[0-9a-f]{64}$'),
    home_uid uuid UNIQUE NOT NULL,
    reservation_id uuid UNIQUE NOT NULL REFERENCES ofz.reservations(id),
    home_bytes bigint NOT NULL CHECK (home_bytes = 34359738368),
    running boolean NOT NULL DEFAULT false,
    runtime_epoch uuid,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'quarantined', 'removed'))
);
CREATE TABLE ofz.collaborators (
    workspace_uid uuid NOT NULL REFERENCES ofz.workspaces(uid),
    human_id text NOT NULL CHECK (human_id ~ '^[0-9a-f]{64}$'),
    role integer NOT NULL CHECK (role BETWEEN 2 AND 3),
    PRIMARY KEY (workspace_uid, human_id)
);
CREATE TABLE ofz.sessions (
    id uuid PRIMARY KEY,
    token_hash bytea UNIQUE NOT NULL CHECK (octet_length(token_hash) = 32),
    human_id text NOT NULL CHECK (human_id ~ '^[0-9a-f]{64}$'),
    identity_subject text NOT NULL,
    github_id text NOT NULL CHECK (github_id ~ '^[1-9][0-9]{0,19}$'),
    display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 256),
    email text NOT NULL DEFAULT '' CHECK (length(email) <= 256),
    image_url text NOT NULL DEFAULT '' CHECK (length(image_url) <= 2048),
    identity_session text NOT NULL,
    operation_id uuid UNIQUE NOT NULL,
    expires_at_ms bigint NOT NULL,
    idle_deadline_ms bigint NOT NULL,
    mfa_at_ms bigint NOT NULL DEFAULT 0,
    recovery_generation bigint NOT NULL,
    revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX sessions_identity ON ofz.sessions(identity_session, identity_subject);
CREATE TABLE ofz.session_revocations (
    operation_id uuid PRIMARY KEY,
    credential_hash bytea NOT NULL CHECK (octet_length(credential_hash) = 32),
    origin text NOT NULL,
    receipt jsonb NOT NULL
);
CREATE TABLE ofz.grants (
    id uuid PRIMARY KEY,
    agent_id uuid NOT NULL,
    issuer_id text NOT NULL CHECK (issuer_id ~ '^[0-9a-f]{64}$'),
    workspace_uid uuid NOT NULL REFERENCES ofz.workspaces(uid),
    resource_kind integer NOT NULL CHECK (resource_kind BETWEEN 2 AND 4),
    resource_id text NOT NULL,
    actions integer[] NOT NULL CHECK (cardinality(actions) > 0),
    scope jsonb NOT NULL,
    proof_key_thumbprint text NOT NULL CHECK (proof_key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
    credential_hash bytea UNIQUE NOT NULL CHECK (octet_length(credential_hash) = 32),
    expires_at_ms bigint NOT NULL,
    recovery_generation bigint NOT NULL,
    revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX grants_issuer ON ofz.grants(issuer_id, workspace_uid);
CREATE TABLE ofz.emergency_approvals (
    operation_id uuid PRIMARY KEY,
    human_id text NOT NULL,
    request jsonb NOT NULL,
    expires_at_ms bigint NOT NULL,
    consumed_by uuid UNIQUE
);
CREATE TABLE ofz.commands (
    operation_id uuid PRIMARY KEY,
    actor_id text NOT NULL,
    workload_id text NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    expected_version bigint NOT NULL UNIQUE,
    prepared jsonb NOT NULL,
    state integer NOT NULL DEFAULT 1 CHECK (state IN (1, 2, 3)),
    receipt jsonb,
    created_at_ms bigint NOT NULL DEFAULT ofz.now_ms()
);
CREATE TABLE ofz.audit (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id uuid UNIQUE NOT NULL,
    receipt jsonb NOT NULL,
    target_hash bytea NOT NULL CHECK (octet_length(target_hash) = 32),
    created_at_ms bigint NOT NULL DEFAULT ofz.now_ms()
);
CREATE TABLE ofz.audit_outbox (
    audit_sequence bigint PRIMARY KEY REFERENCES ofz.audit(sequence),
    acknowledged_at_ms bigint,
    archive_receipt text
);
CREATE TABLE ofz.archive_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    acknowledged_sequence bigint NOT NULL DEFAULT 0,
    acknowledged_at_ms bigint NOT NULL DEFAULT 0,
    batch_hash text NOT NULL DEFAULT ''
);
INSERT INTO ofz.archive_state DEFAULT VALUES;
CREATE TABLE ofz.replay (
    domain text NOT NULL,
    nonce_hash bytea NOT NULL CHECK (octet_length(nonce_hash) = 32),
    expires_at_ms bigint NOT NULL,
    PRIMARY KEY (domain, nonce_hash)
);
CREATE INDEX replay_expiry ON ofz.replay(expires_at_ms);
REVOKE ALL ON ALL TABLES IN SCHEMA ofz FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ofz FROM PUBLIC;
GRANT USAGE ON SCHEMA ofz TO ofz_api, ofz_archiver;
GRANT EXECUTE ON FUNCTION ofz.now_ms() TO ofz_api, ofz_archiver;
GRANT SELECT ON ALL TABLES IN SCHEMA ofz TO ofz_api;
GRANT INSERT, UPDATE, DELETE ON ofz.memberships, ofz.quotas, ofz.collaborators,
    ofz.sessions, ofz.replay TO ofz_api;
GRANT INSERT, UPDATE ON ofz.reservations, ofz.workspaces, ofz.grants, ofz.emergency_approvals TO ofz_api;
GRANT UPDATE ON ofz.platform_state TO ofz_api;
GRANT INSERT ON ofz.commands, ofz.audit, ofz.audit_outbox TO ofz_api;
GRANT INSERT ON ofz.session_revocations TO ofz_api;
GRANT UPDATE (state, receipt) ON ofz.commands TO ofz_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA ofz TO ofz_api;
GRANT SELECT ON ofz.audit, ofz.audit_outbox, ofz.archive_state TO ofz_archiver;
GRANT UPDATE (acknowledged_at_ms, archive_receipt) ON ofz.audit_outbox TO ofz_archiver;
GRANT UPDATE ON ofz.archive_state TO ofz_archiver;
COMMIT;
