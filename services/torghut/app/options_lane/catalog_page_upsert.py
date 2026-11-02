"""Set-based PostgreSQL statement for options catalog page upserts."""

from sqlalchemy import text


CATALOG_PAGE_UPSERT = text(
    """
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset(CAST(:rows AS JSONB)) AS payload (
        contract_symbol TEXT,
        contract_id TEXT,
        root_symbol TEXT,
        underlying_symbol TEXT,
        expiration_date DATE,
        strike_price NUMERIC(18, 6),
        option_type TEXT,
        style TEXT,
        contract_size INTEGER,
        status TEXT,
        tradable BOOLEAN,
        open_interest BIGINT,
        open_interest_date DATE,
        close_price NUMERIC(18, 6),
        close_price_date DATE,
        provider_updated_ts TIMESTAMPTZ,
        first_seen_ts TIMESTAMPTZ,
        last_seen_ts TIMESTAMPTZ,
        metadata JSONB
      )
    )
    INSERT INTO torghut_options_contract_catalog (
      contract_symbol,
      contract_id,
      root_symbol,
      underlying_symbol,
      expiration_date,
      strike_price,
      option_type,
      style,
      contract_size,
      status,
      tradable,
      open_interest,
      open_interest_date,
      close_price,
      close_price_date,
      provider_updated_ts,
      first_seen_ts,
      last_seen_ts,
      metadata
    )
    SELECT contract_symbol,
           contract_id,
           root_symbol,
           underlying_symbol,
           expiration_date,
           strike_price,
           option_type,
           style,
           contract_size,
           status,
           tradable,
           open_interest,
           open_interest_date,
           close_price,
           close_price_date,
           provider_updated_ts,
           first_seen_ts,
           last_seen_ts,
           metadata
    FROM incoming
    ON CONFLICT (contract_symbol) DO UPDATE
    SET contract_id = EXCLUDED.contract_id,
        root_symbol = EXCLUDED.root_symbol,
        underlying_symbol = EXCLUDED.underlying_symbol,
        expiration_date = EXCLUDED.expiration_date,
        strike_price = EXCLUDED.strike_price,
        option_type = EXCLUDED.option_type,
        style = EXCLUDED.style,
        contract_size = EXCLUDED.contract_size,
        status = EXCLUDED.status,
        tradable = EXCLUDED.tradable,
        open_interest = EXCLUDED.open_interest,
        open_interest_date = EXCLUDED.open_interest_date,
        close_price = EXCLUDED.close_price,
        close_price_date = EXCLUDED.close_price_date,
        provider_updated_ts = EXCLUDED.provider_updated_ts,
        last_seen_ts = EXCLUDED.last_seen_ts,
        metadata = EXCLUDED.metadata
    WHERE (
      torghut_options_contract_catalog.contract_id,
      torghut_options_contract_catalog.root_symbol,
      torghut_options_contract_catalog.underlying_symbol,
      torghut_options_contract_catalog.expiration_date,
      torghut_options_contract_catalog.strike_price,
      torghut_options_contract_catalog.option_type,
      torghut_options_contract_catalog.style,
      torghut_options_contract_catalog.contract_size,
      torghut_options_contract_catalog.status,
      torghut_options_contract_catalog.tradable,
      torghut_options_contract_catalog.open_interest,
      torghut_options_contract_catalog.open_interest_date,
      torghut_options_contract_catalog.close_price,
      torghut_options_contract_catalog.close_price_date,
      torghut_options_contract_catalog.provider_updated_ts,
      torghut_options_contract_catalog.metadata
    ) IS DISTINCT FROM (
      EXCLUDED.contract_id,
      EXCLUDED.root_symbol,
      EXCLUDED.underlying_symbol,
      EXCLUDED.expiration_date,
      EXCLUDED.strike_price,
      EXCLUDED.option_type,
      EXCLUDED.style,
      EXCLUDED.contract_size,
      EXCLUDED.status,
      EXCLUDED.tradable,
      EXCLUDED.open_interest,
      EXCLUDED.open_interest_date,
      EXCLUDED.close_price,
      EXCLUDED.close_price_date,
      EXCLUDED.provider_updated_ts,
      EXCLUDED.metadata
    )
    """
)
