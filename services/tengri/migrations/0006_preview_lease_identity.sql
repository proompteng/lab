BEGIN;
ALTER TABLE tengri.schema_version DROP CONSTRAINT schema_version_version_check;
ALTER TABLE tengri.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version BETWEEN 1 AND 6);

UPDATE tengri.previews SET payload=jsonb_set(payload,'{lease_id}',to_jsonb(gen_random_uuid()::text));
ALTER TABLE tengri.previews ADD CONSTRAINT preview_lease_identity
    CHECK (coalesce((payload->>'lease_id')::uuid <> '00000000-0000-0000-0000-000000000000'::uuid,false));
COMMIT;
