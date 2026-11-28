DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM ofz.platform_commands WHERE NOT completed) THEN
        RAISE EXCEPTION 'complete platform commands before workspace onboarding';
    END IF;
END $$;
ALTER TABLE ofz.platform_schema_version DROP CONSTRAINT platform_schema_version_version_check;
ALTER TABLE ofz.platform_schema_version ADD CHECK (version IN (1, 2, 3, 4, 5, 6));
ALTER TABLE ofz.platform_policy_installations ADD COLUMN workspace_changes jsonb NOT NULL DEFAULT '[]';

ALTER TABLE ofz.platform_connections ADD COLUMN workspace_id uuid;
ALTER TABLE ofz.platform_delegations ADD COLUMN workspace_id uuid;
ALTER TABLE ofz.platform_executions ADD COLUMN workspace_id uuid;
CREATE INDEX workspace_activity ON ofz.audit ((receipt->>'platform_workspace_id'), sequence DESC)
    WHERE receipt ? 'platform_workspace_id';

ALTER TABLE ofz.sign_in_attempts ADD COLUMN return_path text NOT NULL DEFAULT '/';
