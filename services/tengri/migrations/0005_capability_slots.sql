BEGIN;
ALTER TABLE tengri.schema_version DROP CONSTRAINT schema_version_version_check;
ALTER TABLE tengri.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version BETWEEN 1 AND 5);

ALTER TABLE tengri.tickets ADD COLUMN capacity_slot smallint, ADD COLUMN workspace_slot smallint;
WITH slots AS (
    SELECT token_hash,row_number() OVER (ORDER BY token_hash) AS capacity_slot,
           row_number() OVER (PARTITION BY workspace_uid ORDER BY token_hash) AS workspace_slot
    FROM tengri.tickets
)
UPDATE tengri.tickets t SET capacity_slot=s.capacity_slot,workspace_slot=s.workspace_slot
FROM slots s WHERE t.token_hash=s.token_hash;
ALTER TABLE tengri.tickets
    ALTER COLUMN capacity_slot SET NOT NULL,
    ALTER COLUMN workspace_slot SET NOT NULL,
    ADD CONSTRAINT ticket_capacity_slot CHECK (capacity_slot BETWEEN 1 AND 128),
    ADD CONSTRAINT ticket_workspace_slot CHECK (workspace_slot BETWEEN 1 AND 16),
    ADD UNIQUE (capacity_slot), ADD UNIQUE (workspace_uid,workspace_slot);

ALTER TABLE tengri.previews ADD COLUMN capacity_slot smallint, ADD COLUMN workspace_slot smallint;
WITH slots AS (
    SELECT id,row_number() OVER (ORDER BY id) AS capacity_slot,
           row_number() OVER (PARTITION BY workspace_uid ORDER BY id) AS workspace_slot
    FROM tengri.previews
)
UPDATE tengri.previews p SET capacity_slot=s.capacity_slot,workspace_slot=s.workspace_slot
FROM slots s WHERE p.id=s.id;
ALTER TABLE tengri.previews
    ALTER COLUMN capacity_slot SET NOT NULL,
    ALTER COLUMN workspace_slot SET NOT NULL,
    ADD CONSTRAINT preview_capacity_slot CHECK (capacity_slot BETWEEN 1 AND 96),
    ADD CONSTRAINT preview_workspace_slot CHECK (workspace_slot BETWEEN 1 AND 16),
    ADD UNIQUE (capacity_slot), ADD UNIQUE (workspace_uid,workspace_slot);
COMMIT;
