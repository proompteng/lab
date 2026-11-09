package ai.proompteng.dorvud.ta.flink

import java.lang.reflect.Proxy
import java.sql.Connection
import java.sql.ResultSet
import java.sql.SQLException
import java.sql.Statement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ClickhouseTaSchemaTest {
  private class Fixture {
    val queries = mutableListOf<String>()
    val timeouts = mutableListOf<Int>()
    var closed = false
    var failure: SQLException? = null
    val tables =
      requiredClickhouseTaColumns.keys.associateWith {
        mutableMapOf(
          "name" to it,
          "engine" to "ReplicatedReplacingMergeTree",
          "create_table_query" to "CREATE TABLE $it (...) TTL toDateTime(event_ts) + toIntervalDay(35) SETTINGS index_granularity = 8192",
        )
      }.toMutableMap()
    val columns =
      requiredClickhouseTaColumns.flatMap { (table, fields) ->
        fields.map { (name, type) -> mutableMapOf("table" to table, "name" to name, "type" to type) }
      }.toMutableList()

    private fun rows(values: List<Map<String, String>>): ResultSet {
      var index = -1
      return proxy { method, args ->
        when (method) {
          "next" -> ++index < values.size
          "getString" -> values[index].getValue(args[0] as String)
          "close" -> null
          else -> error("Unexpected ResultSet call: $method")
        }
      }
    }

    val connection: Connection =
      proxy { method, _ ->
        check(method == "createStatement") { "Unexpected Connection call: $method" }
        proxy<Statement> { statementMethod, args ->
          when (statementMethod) {
            "setQueryTimeout" -> {
              timeouts += args[0] as Int
              null
            }
            "executeQuery" -> {
              val sql = args[0] as String
              queries += sql
              failure?.let { throw it }
              check(sql.startsWith("SELECT ")) { "Startup must be read-only: $sql" }
              when {
                "FROM system.tables " in sql -> rows(tables.values.toList())
                "FROM system.columns " in sql -> rows(columns)
                else -> error("Unexpected query: $sql")
              }
            }
            "close" -> {
              closed = true
              null
            }
            else -> error("Startup attempted a non-read operation: $statementMethod")
          }
        }
      }
  }

  @Test
  fun `healthy schema submits no DDL and bounds both reads`() {
    val fixture = Fixture()
    verifyClickhouseTaSchema(fixture.connection, "torghut", true)
    assertEquals(2, fixture.queries.size)
    assertEquals(listOf(15), fixture.timeouts)
    assertTrue(fixture.closed)
    assertTrue(fixture.queries.all { "database = 'torghut'" in it })
  }

  @Test
  fun `schema database is escaped and never replaced by a default`() {
    val fixture = Fixture()
    verifyClickhouseTaSchema(fixture.connection, "tenant'one", true)
    assertTrue(fixture.queries.all { "database = 'tenant''one'" in it })
  }

  @Test
  fun `missing table and nonreplicated table reject startup`() {
    for (table in requiredClickhouseTaColumns.keys) {
      val missing = Fixture()
      missing.tables.remove(table)
      assertFailsWith<IllegalStateException> { verifyClickhouseTaSchema(missing.connection, "torghut", true) }
      val local = Fixture()
      local.tables.getValue(table)["engine"] = "ReplacingMergeTree"
      assertFailsWith<IllegalStateException> { verifyClickhouseTaSchema(local.connection, "torghut", true) }
    }
  }

  @Test
  fun `missing columns wrong types and retention drift reject startup without repair`() {
    val missing = Fixture()
    missing.columns.removeAll { it["name"] == "microstructure_signal_v1" }
    val wrongType = Fixture()
    wrongType.columns.first { it["name"] == "seq" }["type"] = "UInt32"
    val wrongTtl = Fixture()
    wrongTtl.tables.getValue("ta_signals")["create_table_query"] = "TTL toDateTime(event_ts) + toIntervalDay(14)"
    for (fixture in listOf(missing, wrongType, wrongTtl)) {
      assertFailsWith<IllegalStateException> { verifyClickhouseTaSchema(fixture.connection, "torghut", true) }
      assertEquals(2, fixture.queries.size)
      assertTrue(fixture.closed)
    }
  }

  @Test
  fun `query failure is propagated and never becomes a schema write or success`() {
    val fixture = Fixture()
    fixture.failure = SQLException("bounded read failed")
    val failure = assertFailsWith<SQLException> { verifyClickhouseTaSchema(fixture.connection, "torghut", true) }
    assertEquals("bounded read failed", failure.message)
    assertEquals(1, fixture.queries.size)
    assertTrue(fixture.closed)
  }

  @Test
  fun `required columns match the retained migration resource`() {
    val schema = requireNotNull(javaClass.getResourceAsStream("/ta-schema.sql")).bufferedReader().use { it.readText() }
    for ((table, expected) in requiredClickhouseTaColumns) {
      val body = schema.substringAfter("CREATE TABLE IF NOT EXISTS torghut.$table ON CLUSTER default\n(\n").substringBefore("\n)\nENGINE")
      val actual =
        body.lineSequence().associate { line ->
          val parts = line.trim().removeSuffix(",").split(" ", limit = 2)
          parts[0] to parts[1]
        }
      assertEquals(expected, actual)
    }
  }

  companion object {
    private inline fun <reified T> proxy(crossinline call: (String, Array<out Any?>) -> Any?): T =
      Proxy.newProxyInstance(T::class.java.classLoader, arrayOf(T::class.java)) { _, method, args ->
        call(method.name, args ?: emptyArray())
      } as T
  }
}

