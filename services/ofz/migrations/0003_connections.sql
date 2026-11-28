DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM ofz.platform_commands WHERE NOT completed) THEN
        RAISE EXCEPTION 'complete platform commands before migrating connection authority';
    END IF;
END $$;

ALTER TABLE ofz.platform_schema_version DROP CONSTRAINT platform_schema_version_version_check;
ALTER TABLE ofz.platform_schema_version ADD CHECK (version IN (1, 2));

CREATE TABLE ofz.platform_connections (
    id uuid PRIMARY KEY,
    issuer_id text NOT NULL,
    client_service text NOT NULL,
    client_reference text NOT NULL,
    actions jsonb NOT NULL,
    resources jsonb NOT NULL,
    binding_service text NOT NULL,
    binding_id text NOT NULL,
    version bigint NOT NULL CHECK (version > 0),
    enabled boolean NOT NULL,
    last_delegation_id uuid REFERENCES ofz.platform_delegations(id),
    credential_generation bigint NOT NULL CHECK (credential_generation > 0),
    recovery_generation bigint NOT NULL CHECK (recovery_generation > 0),
    updated_at_ms bigint NOT NULL DEFAULT ofz.now_ms(),
    UNIQUE (issuer_id, client_service, client_reference),
    CHECK ((binding_service = '') = (binding_id = ''))
);
CREATE INDEX platform_connections_owner_binding
    ON ofz.platform_connections (issuer_id, client_service, binding_service, binding_id);

ALTER TABLE ofz.platform_delegations
    ADD COLUMN connection_id uuid REFERENCES ofz.platform_connections(id),
    ADD COLUMN connection_version bigint,
    ADD COLUMN credential_generation bigint;

UPDATE ofz.platform_delegations SET active=false, revoked=true;
ALTER TABLE ofz.platform_delegations ADD CHECK (
    (connection_id IS NULL AND connection_version IS NULL AND credential_generation IS NULL AND revoked)
    OR (connection_id IS NOT NULL AND connection_version IS NOT NULL AND connection_version > 0
        AND credential_generation IS NOT NULL AND credential_generation > 0)
);
CREATE INDEX platform_delegations_connection ON ofz.platform_delegations (connection_id);

ALTER TABLE ofz.platform_commands ADD CONSTRAINT platform_connection_command_contract CHECK (
    NOT (prepared->'command' ? 'Create')
    OR (prepared->'command'->'Create'->>'connection_id' IS NOT NULL
        AND length(prepared->'command'->'Create'->>'connection_id') = 36
        AND prepared->'command'->'Create'->>'expected_connection_version' IS NOT NULL
        AND (prepared->'command'->'Create'->>'expected_connection_version')::bigint > 0)
) NOT VALID;

REVOKE ALL ON ofz.platform_connections FROM PUBLIC;
GRANT SELECT, INSERT ON ofz.platform_connections TO ofz_api;
GRANT UPDATE (actions,resources,binding_service,binding_id,version,enabled,last_delegation_id,
    credential_generation,recovery_generation,updated_at_ms) ON ofz.platform_connections TO ofz_api;
