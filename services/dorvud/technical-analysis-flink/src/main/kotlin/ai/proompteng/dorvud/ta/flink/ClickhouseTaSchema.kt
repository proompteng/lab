package ai.proompteng.dorvud.ta.flink

import java.sql.Connection

private val commonTaColumns =
  mapOf(
    "symbol" to "LowCardinality(String)",
    "event_ts" to "DateTime64(3, 'UTC')",
    "seq" to "UInt64",
    "ingest_ts" to "DateTime64(3, 'UTC')",
    "is_final" to "UInt8",
    "source" to "LowCardinality(String)",
    "window_size" to "LowCardinality(String)",
    "window_step" to "Nullable(String)",
    "window_start" to "Nullable(DateTime64(3, 'UTC'))",
    "window_end" to "Nullable(DateTime64(3, 'UTC'))",
    "version" to "UInt32",
  )

internal val requiredClickhouseTaColumns =
  mapOf(
    "ta_microbars" to
      commonTaColumns +
      mapOf(
        "o" to "Float64",
        "h" to "Float64",
        "l" to "Float64",
        "c" to "Float64",
        "v" to "Float64",
        "vwap" to "Nullable(Float64)",
        "count" to "UInt64",
      ),
    "ta_signals" to
      commonTaColumns +
      mapOf(
        "macd" to "Nullable(Float64)",
        "macd_signal" to "Nullable(Float64)",
        "macd_hist" to "Nullable(Float64)",
        "ema12" to "Nullable(Float64)",
        "ema26" to "Nullable(Float64)",
        "rsi14" to "Nullable(Float64)",
        "boll_mid" to "Nullable(Float64)",
        "boll_upper" to "Nullable(Float64)",
        "boll_lower" to "Nullable(Float64)",
        "vwap_session" to "Nullable(Float64)",
        "vwap_w5m" to "Nullable(Float64)",
        "imbalance_spread" to "Nullable(Float64)",
        "imbalance_bid_px" to "Nullable(Float64)",
        "imbalance_ask_px" to "Nullable(Float64)",
        "imbalance_bid_sz" to "Nullable(UInt64)",
        "imbalance_ask_sz" to "Nullable(UInt64)",
        "vol_realized_w60s" to "Nullable(Float64)",
        "microstructure_signal_v1" to "Nullable(String)",
      ),
  )

private val taRetention =
  Regex("""\bTTL\s+toDateTime\(event_ts\)\s*\+\s*(?:toIntervalDay\(35\)|INTERVAL\s+35\s+DAY)(?:\s|$)""")

/**
 * Startup verifies the schema it will write, but never runs migrations. In particular, a healthy
 * JobManager must not wait on distributed DDL before submitting the streaming graph.
 */
internal fun verifyClickhouseTaSchema(
  connection: Connection,
  database: String,
  requireReplicatedTables: Boolean,
) {
  val escapedDatabase = database.replace("'", "''")
  val tables = requiredClickhouseTaColumns.keys.joinToString(",") { "'$it'" }
  val engines = mutableMapOf<String, String>()
  val definitions = mutableMapOf<String, String>()
  val columns = mutableMapOf<String, MutableMap<String, String>>()

  connection.createStatement().use { statement ->
    statement.queryTimeout = 15
    statement
      .executeQuery(
        "SELECT name, engine, create_table_query FROM system.tables " +
          "WHERE database = '$escapedDatabase' AND name IN ($tables)",
      ).use { rows ->
        while (rows.next()) {
          val table = rows.getString("name")
          engines[table] = rows.getString("engine")
          definitions[table] = rows.getString("create_table_query")
        }
      }
    statement
      .executeQuery(
        "SELECT table, name, type FROM system.columns " +
          "WHERE database = '$escapedDatabase' AND table IN ($tables)",
      ).use { rows ->
        while (rows.next()) {
          columns.getOrPut(rows.getString("table")) { mutableMapOf() }[rows.getString("name")] = rows.getString("type")
        }
      }
  }

  if (requireReplicatedTables) validateClickhouseTaTableEngines(engines)
  val issues = mutableListOf<String>()
  for ((table, expectedColumns) in requiredClickhouseTaColumns) {
    if (engines[table] == null) {
      issues += "$table=missing"
      continue
    }
    if (!taRetention.containsMatchIn(definitions[table].orEmpty())) {
      issues += "$table retention must be 35 days"
    }
    for ((column, expectedType) in expectedColumns) {
      val actualType = columns[table]?.get(column)
      if (actualType?.replace(" ", "") != expectedType.replace(" ", "")) {
        issues += "$table.$column must be $expectedType"
      }
    }
  }
  check(issues.isEmpty()) {
    "ClickHouse TA sink schema is incompatible; apply the reviewed schema migration before startup: ${issues.joinToString(", ")}"
  }
}

