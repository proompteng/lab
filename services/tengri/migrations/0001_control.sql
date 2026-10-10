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

CREATE TABLE tengri.replay_nonces (
    nonce_hash bytea PRIMARY KEY CHECK (octet_length(nonce_hash)=32),
    expires_at_ms bigint NOT NULL
);
CREATE INDEX replay_nonce_expiry ON tengri.replay_nonces(expires_at_ms);
CREATE FUNCTION tengri.consume_nonce(p_nonce_hash bytea,p_expires_at_ms bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(726635522920);
    DELETE FROM tengri.replay_nonces WHERE expires_at_ms<=tengri.now_ms();
    IF p_expires_at_ms<=tengri.now_ms() OR p_expires_at_ms>tengri.now_ms()+5000 THEN
        RAISE EXCEPTION 'Invalid nonce deadline' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(*) FROM tengri.replay_nonces)>=8192 THEN
        RAISE EXCEPTION 'Replay state capacity exhausted' USING ERRCODE='53300';
    END IF;
    INSERT INTO tengri.replay_nonces VALUES(p_nonce_hash,p_expires_at_ms) ON CONFLICT DO NOTHING;
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION tengri.consume_nonce(bytea,bigint) FROM PUBLIC;

CREATE TABLE tengri.tickets (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash)=32),
    agent_id text NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 253),
    workspace_uid uuid NOT NULL,
    session_id uuid,
    payload jsonb NOT NULL CHECK (octet_length(payload::text)<=16384),
    expires_at_ms bigint NOT NULL
);
CREATE INDEX ticket_expiry ON tengri.tickets(expires_at_ms);
CREATE INDEX ticket_agent ON tengri.tickets(agent_id);
CREATE INDEX ticket_session ON tengri.tickets(session_id);
CREATE TABLE tengri.previews (
    id text PRIMARY KEY CHECK (id ~ '^[a-z0-9]{24}$'),
    token_hash bytea NOT NULL CHECK (octet_length(token_hash)=32),
    revocation_hash bytea NOT NULL CHECK (octet_length(revocation_hash)=32),
    agent_id text NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 253),
    workspace_uid uuid NOT NULL,
    session_id uuid,
    payload jsonb NOT NULL CHECK (octet_length(payload::text)<=16384),
    expires_at_ms bigint NOT NULL
);
CREATE INDEX preview_expiry ON tengri.previews(expires_at_ms);
CREATE INDEX preview_agent ON tengri.previews(agent_id);
CREATE INDEX preview_session ON tengri.previews(session_id);

CREATE TABLE tengri.runtime_leader (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    owner uuid,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation>=0),
    expires_at_ms bigint NOT NULL DEFAULT 0
);
INSERT INTO tengri.runtime_leader(singleton) VALUES(true);
CREATE FUNCTION tengri.acquire_leadership(candidate uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_generation bigint;
BEGIN
    UPDATE tengri.runtime_leader SET owner=candidate,generation=generation+1,expires_at_ms=tengri.now_ms()+15000
      WHERE singleton AND expires_at_ms<=tengri.now_ms() RETURNING generation INTO current_generation;
    RETURN current_generation;
END;
$$;
CREATE FUNCTION tengri.renew_leadership(candidate uuid,expected_generation bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    UPDATE tengri.runtime_leader SET expires_at_ms=tengri.now_ms()+15000
      WHERE singleton AND owner=candidate AND generation=expected_generation AND expires_at_ms>tengri.now_ms();
    RETURN FOUND;
END;
$$;
CREATE FUNCTION tengri.release_leadership(candidate uuid,expected_generation bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
    UPDATE tengri.runtime_leader SET expires_at_ms=0
      WHERE singleton AND owner=candidate AND generation=expected_generation;
$$;
REVOKE ALL ON FUNCTION tengri.acquire_leadership(uuid),tengri.renew_leadership(uuid,bigint),tengri.release_leadership(uuid,bigint) FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA tengri FROM PUBLIC;
GRANT USAGE ON SCHEMA tengri TO tengri_bff,tengri_controller,tengri_supervisor;
GRANT SELECT ON tengri.schema_version TO tengri_bff,tengri_controller,tengri_supervisor;
GRANT EXECUTE ON FUNCTION tengri.now_ms() TO tengri_bff,tengri_controller,tengri_supervisor;
GRANT SELECT,DELETE ON tengri.oauth_attempts TO tengri_bff;
GRANT EXECUTE ON FUNCTION tengri.begin_oauth(bytea,bytea,text,text,uuid) TO tengri_bff;
GRANT SELECT,INSERT,DELETE,UPDATE ON tengri.tickets,tengri.previews TO tengri_controller;
GRANT SELECT ON tengri.runtime_leader TO tengri_controller,tengri_supervisor;
GRANT EXECUTE ON FUNCTION tengri.consume_nonce(bytea,bigint),tengri.acquire_leadership(uuid),tengri.renew_leadership(uuid,bigint),tengri.release_leadership(uuid,bigint) TO tengri_controller;
COMMIT;
