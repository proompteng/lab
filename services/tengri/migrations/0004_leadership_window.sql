BEGIN;
ALTER TABLE tengri.schema_version DROP CONSTRAINT schema_version_version_check;
ALTER TABLE tengri.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version BETWEEN 1 AND 4);

CREATE OR REPLACE FUNCTION tengri.acquire_leadership(candidate uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_generation bigint;
BEGIN
    UPDATE tengri.runtime_leader SET owner=candidate,generation=generation+1,expires_at_ms=tengri.now_ms()+60000
      WHERE singleton AND expires_at_ms<=tengri.now_ms() RETURNING generation INTO current_generation;
    RETURN current_generation;
END;
$$;
CREATE OR REPLACE FUNCTION tengri.renew_leadership(candidate uuid,expected_generation bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    UPDATE tengri.runtime_leader SET expires_at_ms=tengri.now_ms()+60000
      WHERE singleton AND owner=candidate AND generation=expected_generation AND expires_at_ms>tengri.now_ms();
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION tengri.acquire_leadership(uuid),tengri.renew_leadership(uuid,bigint) FROM PUBLIC;
COMMIT;
