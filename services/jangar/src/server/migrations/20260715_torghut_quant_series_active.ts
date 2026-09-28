import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

const ACTIVE_TABLE = 'torghut_control_plane.quant_metrics_series_active'
const PARTITION_COUNT = 16

const SERIES_COLUMNS = `
  id,
  strategy_id,
  account,
  "window",
  metric_name,
  status,
  quality,
  unit,
  value_numeric,
  value_json,
  meta_json,
  formula_version,
  as_of,
  freshness_seconds,
  created_at
`

export const up = async (db: Kysely<Database>) => {
  await sql`SET LOCAL lock_timeout = '5s';`.execute(db)

  // The legacy relation is 146 GiB even though its 7.47 million live rows are
  // small. Renaming it is metadata-only and preserves every historical row.
  await sql`
    ALTER TABLE torghut_control_plane.quant_metrics_series
    RENAME TO quant_metrics_series_legacy;
  `.execute(db)

  // Hash partitioning is static and matches the mandatory strategy filter on
  // every series read. The active table stays logged; this changes layout, not
  // PostgreSQL durability.
  await sql`
    CREATE TABLE ${sql.table(ACTIVE_TABLE)} (
      LIKE torghut_control_plane.quant_metrics_series_legacy
      INCLUDING DEFAULTS
      INCLUDING GENERATED
      INCLUDING STORAGE
    ) PARTITION BY HASH (strategy_id);
  `.execute(db)

  for (let remainder = 0; remainder < PARTITION_COUNT; remainder += 1) {
    const partition = `${ACTIVE_TABLE}_p${String(remainder).padStart(2, '0')}`
    await sql`
      CREATE TABLE ${sql.table(partition)}
      PARTITION OF ${sql.table(ACTIVE_TABLE)}
      FOR VALUES WITH (
        MODULUS ${sql.raw(String(PARTITION_COUNT))},
        REMAINDER ${sql.raw(String(remainder))}
      );
    `.execute(db)
  }

  await sql`
    CREATE INDEX torghut_qm_series_active_lookup_idx
    ON ${sql.table(ACTIVE_TABLE)} (strategy_id, account, "window", metric_name, as_of DESC);
  `.execute(db)

  await sql`
    CREATE INDEX torghut_qm_series_active_as_of_brin
    ON ${sql.table(ACTIVE_TABLE)} USING BRIN (as_of) WITH (pages_per_range = 64);
  `.execute(db)

  await sql
    .raw(`
    CREATE VIEW torghut_control_plane.quant_metrics_series AS
    SELECT ${SERIES_COLUMNS}
    FROM torghut_control_plane.quant_metrics_series_legacy
    UNION ALL
    SELECT ${SERIES_COLUMNS}
    FROM torghut_control_plane.quant_metrics_series_active;
  `)
    .execute(db)

  await sql`
    CREATE FUNCTION torghut_control_plane.insert_quant_metrics_series_active()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO torghut_control_plane.quant_metrics_series_active (
        id,
        strategy_id,
        account,
        "window",
        metric_name,
        status,
        quality,
        unit,
        value_numeric,
        value_json,
        meta_json,
        formula_version,
        as_of,
        freshness_seconds,
        created_at
      ) VALUES (
        COALESCE(NEW.id, gen_random_uuid()),
        NEW.strategy_id,
        COALESCE(NEW.account, ''),
        NEW."window",
        NEW.metric_name,
        COALESCE(NEW.status, 'ok'),
        COALESCE(NEW.quality, 'good'),
        COALESCE(NEW.unit, ''),
        NEW.value_numeric,
        COALESCE(NEW.value_json, '{}'::jsonb),
        COALESCE(NEW.meta_json, '{}'::jsonb),
        NEW.formula_version,
        NEW.as_of,
        COALESCE(NEW.freshness_seconds, 0),
        COALESCE(NEW.created_at, now())
      )
      RETURNING * INTO NEW;

      RETURN NEW;
    END;
    $$;
  `.execute(db)

  await sql`
    CREATE TRIGGER quant_metrics_series_active_insert
    INSTEAD OF INSERT ON torghut_control_plane.quant_metrics_series
    FOR EACH ROW
    EXECUTE FUNCTION torghut_control_plane.insert_quant_metrics_series_active();
  `.execute(db)
}

// Intentionally forward-only. The later quant-series removal migration hard-deletes
// every series relation, so restoring the compatibility view is unsupported.
