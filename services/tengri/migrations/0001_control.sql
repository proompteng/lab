BEGIN;
CREATE SCHEMA tengri;
REVOKE ALL ON SCHEMA tengri FROM PUBLIC;
CREATE TABLE tengri.schema_version (version integer PRIMARY KEY CHECK (version=1), checksum bytea NOT NULL CHECK (octet_length(checksum)=32));
CREATE FUNCTION tengri.now_ms() RETURNS bigint LANGUAGE sql VOLATILE
AS $$ SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint $$;
CREATE TABLE tengri.oauth_attempts (
    state_hash bytea PRIMARY KEY CHECK (octet_length(state_hash)=32),
    binding_hash bytea NOT NULL CHECK (octet_length(binding_hash)=32),
    verifier text NOT NULL CHECK (length(verifier)=43),
    nonce text NOT NULL CHECK (length(nonce)=43),
    operation_id uuid UNIQUE NOT NULL,
    expires_at_ms bigint NOT NULL
);
CREATE INDEX oauth_attempt_expiry ON tengri.oauth_attempts(expires_at_ms);
CREATE FUNCTION tengri.begin_oauth(state_hash bytea,binding_hash bytea,verifier text,nonce text,operation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(726635522919);
    DELETE FROM tengri.oauth_attempts WHERE expires_at_ms<=tengri.now_ms();
    IF (SELECT count(*) FROM tengri.oauth_attempts)>=2000 THEN
        RAISE EXCEPTION 'OAuth attempt capacity exhausted' USING ERRCODE='53300';
    END IF;
    INSERT INTO tengri.oauth_attempts VALUES(state_hash,binding_hash,verifier,nonce,operation_id,tengri.now_ms()+300000);
END;
$$;
REVOKE ALL ON FUNCTION tengri.begin_oauth(bytea,bytea,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA tengri FROM PUBLIC;
GRANT USAGE ON SCHEMA tengri TO tengri_bff,tengri_controller;
GRANT SELECT ON tengri.schema_version TO tengri_bff,tengri_controller;
GRANT EXECUTE ON FUNCTION tengri.now_ms() TO tengri_bff,tengri_controller;
GRANT SELECT,DELETE ON tengri.oauth_attempts TO tengri_bff;
GRANT EXECUTE ON FUNCTION tengri.begin_oauth(bytea,bytea,text,text,uuid) TO tengri_bff;
COMMIT;
