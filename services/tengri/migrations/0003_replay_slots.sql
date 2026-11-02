BEGIN;
ALTER TABLE tengri.schema_version DROP CONSTRAINT schema_version_version_check;
ALTER TABLE tengri.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version BETWEEN 1 AND 3);

LOCK TABLE tengri.replay_nonces IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE replay_nonce_migration ON COMMIT DROP AS
SELECT nonce_hash,expires_at_ms,get_byte(nonce_hash,0)%64 AS bucket,
       row_number() OVER (PARTITION BY get_byte(nonce_hash,0)%64 ORDER BY nonce_hash)-1 AS slot
FROM tengri.replay_nonces WHERE expires_at_ms>tengri.now_ms();
DROP TABLE tengri.replay_nonces;
CREATE TABLE tengri.replay_nonces (
    bucket smallint NOT NULL CHECK (bucket BETWEEN 0 AND 63),
    slot smallint NOT NULL CHECK (slot BETWEEN 0 AND 127),
    nonce_hash bytea UNIQUE CHECK (octet_length(nonce_hash)=32 AND get_byte(nonce_hash,0)%64=bucket),
    expires_at_ms bigint NOT NULL,
    PRIMARY KEY (bucket,slot)
);
INSERT INTO tengri.replay_nonces
SELECT b,s,m.nonce_hash,coalesce(m.expires_at_ms,0)
FROM generate_series(0,63) b CROSS JOIN generate_series(0,127) s
LEFT JOIN replay_nonce_migration m ON m.bucket=b AND m.slot=s;

CREATE OR REPLACE FUNCTION tengri.consume_nonce(p_nonce_hash bytea,p_expires_at_ms bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_now bigint; v_bucket smallint; v_slot smallint;
BEGIN
    IF p_nonce_hash IS NULL OR octet_length(p_nonce_hash)<>32 THEN
        RAISE EXCEPTION 'Invalid nonce hash' USING ERRCODE='22023';
    END IF;
    v_now := tengri.now_ms();
    IF p_expires_at_ms IS NULL OR p_expires_at_ms<=v_now OR p_expires_at_ms>v_now+6000 THEN
        RAISE EXCEPTION 'Invalid nonce deadline' USING ERRCODE='22023';
    END IF;
    v_bucket := get_byte(p_nonce_hash,0)%64;
    IF EXISTS(SELECT 1 FROM tengri.replay_nonces WHERE nonce_hash=p_nonce_hash AND expires_at_ms>v_now) THEN
        RETURN false;
    END IF;
    SELECT slot INTO v_slot FROM tengri.replay_nonces
    WHERE bucket=v_bucket AND expires_at_ms<=v_now
    ORDER BY (nonce_hash=p_nonce_hash) DESC NULLS LAST,expires_at_ms,slot
    FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Replay state capacity exhausted' USING ERRCODE='53300';
    END IF;
    UPDATE tengri.replay_nonces SET nonce_hash=p_nonce_hash,expires_at_ms=p_expires_at_ms
    WHERE bucket=v_bucket AND slot=v_slot;
    RETURN true;
EXCEPTION WHEN unique_violation THEN
    RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION tengri.consume_nonce(bytea,bigint) FROM PUBLIC;
COMMIT;
