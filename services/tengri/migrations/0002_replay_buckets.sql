BEGIN;
ALTER TABLE tengri.schema_version DROP CONSTRAINT schema_version_version_check;
ALTER TABLE tengri.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version BETWEEN 1 AND 2);

DROP INDEX tengri.replay_nonce_expiry;
CREATE INDEX replay_nonce_bucket_expiry ON tengri.replay_nonces ((get_byte(nonce_hash,0)%64),expires_at_ms);
CREATE OR REPLACE FUNCTION tengri.consume_nonce(p_nonce_hash bytea,p_expires_at_ms bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_now bigint; v_bucket integer;
BEGIN
    IF octet_length(p_nonce_hash)<>32 THEN
        RAISE EXCEPTION 'Invalid nonce hash' USING ERRCODE='22023';
    END IF;
    v_bucket := get_byte(p_nonce_hash,0)%64;
    PERFORM pg_advisory_xact_lock(726635523000+v_bucket);
    v_now := tengri.now_ms();
    DELETE FROM tengri.replay_nonces WHERE get_byte(nonce_hash,0)%64=v_bucket AND expires_at_ms<=v_now;
    IF p_expires_at_ms<=v_now OR p_expires_at_ms>v_now+6000 THEN
        RAISE EXCEPTION 'Invalid nonce deadline' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(*) FROM tengri.replay_nonces WHERE get_byte(nonce_hash,0)%64=v_bucket)>=128 THEN
        RAISE EXCEPTION 'Replay state capacity exhausted' USING ERRCODE='53300';
    END IF;
    INSERT INTO tengri.replay_nonces VALUES(p_nonce_hash,p_expires_at_ms) ON CONFLICT DO NOTHING;
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION tengri.consume_nonce(bytea,bigint) FROM PUBLIC;
COMMIT;
