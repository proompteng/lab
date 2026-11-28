CREATE TABLE ofz.platform_schema_version (
    version integer PRIMARY KEY CHECK (version = 1),
    checksum bytea NOT NULL CHECK (octet_length(checksum) = 32)
);
CREATE TABLE ofz.platform_policy_installations (
    operation_id uuid PRIMARY KEY,
    previous_hash bytea NOT NULL CHECK (octet_length(previous_hash) = 32),
    desired_hash bytea NOT NULL CHECK (octet_length(desired_hash) = 32),
    catalog_hash bytea NOT NULL CHECK (octet_length(catalog_hash) = 32),
    registry_hash bytea NOT NULL CHECK (octet_length(registry_hash) = 32),
    expected_version bigint NOT NULL,
    schema_text text NOT NULL,
    completed boolean NOT NULL DEFAULT false,
    native_revision text,
    created_at_ms bigint NOT NULL DEFAULT ofz.now_ms(),
    completed_at_ms bigint
);
CREATE UNIQUE INDEX platform_policy_installation_pending
    ON ofz.platform_policy_installations ((true)) WHERE NOT completed;
CREATE TABLE ofz.platform_delegations (
    id uuid PRIMARY KEY,
    operation_id uuid NOT NULL UNIQUE,
    agent_id uuid NOT NULL,
    issuer_id text NOT NULL,
    client_service text NOT NULL,
    credential_hash bytea NOT NULL CHECK (octet_length(credential_hash) = 32),
    proof_key_thumbprint text NOT NULL,
    actions jsonb NOT NULL,
    resources jsonb NOT NULL,
    binding jsonb,
    expires_at_ms bigint NOT NULL,
    recovery_generation bigint NOT NULL,
    active boolean NOT NULL DEFAULT false,
    revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX platform_delegations_expiry ON ofz.platform_delegations (expires_at_ms);
CREATE TABLE ofz.platform_commands (
    operation_id uuid PRIMARY KEY,
    workload_id text NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    prepared jsonb NOT NULL,
    completed boolean NOT NULL DEFAULT false,
    response jsonb
);
CREATE UNIQUE INDEX platform_command_pending
    ON ofz.platform_commands ((true)) WHERE NOT completed;
CREATE TABLE ofz.platform_executions (
    operation_id uuid PRIMARY KEY,
    authorization_receipt_id uuid NOT NULL REFERENCES ofz.audit(id),
    outcome text NOT NULL CHECK (outcome IN ('started','succeeded','failed','withheld')),
    upstream_status integer NOT NULL,
    result_hash bytea NOT NULL,
    audit_receipt_id uuid NOT NULL REFERENCES ofz.audit(id)
);
CREATE VIEW ofz.platform_bindings AS
    SELECT 'tengri'::text AS service, uid::text AS id, runtime_epoch::text AS generation,
           owner_id AS issuer_id, state = 'active' AND running AND runtime_epoch IS NOT NULL AS active
    FROM ofz.workspaces;
REVOKE ALL ON ofz.platform_schema_version, ofz.platform_policy_installations,
    ofz.platform_delegations, ofz.platform_bindings, ofz.platform_commands, ofz.platform_executions FROM PUBLIC;
GRANT SELECT ON ofz.platform_schema_version, ofz.platform_policy_installations,
    ofz.platform_delegations, ofz.platform_bindings, ofz.platform_commands, ofz.platform_executions TO ofz_api;
GRANT INSERT ON ofz.platform_delegations TO ofz_api;
GRANT UPDATE (active,revoked) ON ofz.platform_delegations TO ofz_api;
GRANT INSERT ON ofz.platform_commands, ofz.platform_executions TO ofz_api;
GRANT UPDATE (completed,response) ON ofz.platform_commands TO ofz_api;
GRANT UPDATE (outcome,upstream_status,result_hash,audit_receipt_id) ON ofz.platform_executions TO ofz_api;

-- Retire the superseded Tengri connector and Kubernetes grants at the hard cutover.
UPDATE ofz.grants SET revoked=true WHERE resource_kind IN (3,4);
