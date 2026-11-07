ALTER TABLE ofz.platform_schema_version DROP CONSTRAINT platform_schema_version_version_check;
ALTER TABLE ofz.platform_schema_version ADD CHECK (version IN (1, 2, 3, 4));

ALTER TABLE ofz.sessions ADD COLUMN gateway_service text;
UPDATE ofz.sessions SET gateway_service='tengri-web';
ALTER TABLE ofz.sessions ALTER COLUMN gateway_service SET NOT NULL;
ALTER TABLE ofz.sessions ADD CHECK (length(gateway_service) BETWEEN 1 AND 128);
