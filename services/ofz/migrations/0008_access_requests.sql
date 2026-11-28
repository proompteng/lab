DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM ofz.platform_commands WHERE NOT completed) THEN
        RAISE EXCEPTION 'complete platform commands before access-request migration';
    END IF;
END $$;
ALTER TABLE ofz.platform_schema_version DROP CONSTRAINT platform_schema_version_version_check;
ALTER TABLE ofz.platform_schema_version ADD CHECK (version IN (1, 2, 3, 4, 5, 6, 7));

CREATE TABLE ofz.platform_access_requests (
    id uuid PRIMARY KEY,
    issuer_id text NOT NULL,
    client_service text NOT NULL,
    workspace_id uuid NOT NULL,
    resource jsonb NOT NULL,
    actions jsonb NOT NULL CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) BETWEEN 1 AND 16),
    scope_hash bytea NOT NULL CHECK (octet_length(scope_hash) = 32),
    reason text NOT NULL CHECK (octet_length(reason) <= 512),
    state smallint NOT NULL DEFAULT 1 CHECK (state IN (1, 2, 3, 4)),
    decision_reason text NOT NULL DEFAULT '' CHECK (octet_length(decision_reason) <= 512),
    created_at_ms bigint NOT NULL DEFAULT ofz.now_ms(),
    updated_at_ms bigint NOT NULL DEFAULT ofz.now_ms()
);
CREATE UNIQUE INDEX access_request_pending_scope
    ON ofz.platform_access_requests (issuer_id, client_service, workspace_id, scope_hash) WHERE state = 1;
CREATE INDEX access_request_workspace
    ON ofz.platform_access_requests (workspace_id, state, created_at_ms);
CREATE INDEX access_request_issuer
    ON ofz.platform_access_requests (issuer_id, client_service, state, updated_at_ms DESC);
REVOKE ALL ON ofz.platform_access_requests FROM PUBLIC;
GRANT SELECT, INSERT ON ofz.platform_access_requests TO ofz_api;
GRANT UPDATE (state, decision_reason, updated_at_ms) ON ofz.platform_access_requests TO ofz_api;
