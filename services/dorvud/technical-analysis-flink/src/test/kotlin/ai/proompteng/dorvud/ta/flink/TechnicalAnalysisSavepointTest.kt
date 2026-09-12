package ai.proompteng.dorvud.ta.flink

import org.apache.flink.connector.base.DeliveryGuarantee
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class TechnicalAnalysisSavepointTest {
  @Test
  fun `feature branch preserves every existing technical analysis savepoint operator`() {
    val symbols = setOf("AAPL", "SPY")
    val features =
      RollingMarketFeatureConfig(
        "torghut.market-features.v1",
        "torghut.bars.1m.v1",
        ArchiveUniverse("test-equity-v1", canonicalSymbolHash(symbols.toList()), symbols),
        "test-revision",
      )
    val config =
      FlinkTaConfig.fromEnv().copy(
        quotesTopic = "torghut.quotes.v1",
        bars1mTopic = "torghut.bars.1m.v1",
        statusTopic = "torghut.ta.status.v1",
        deliveryGuarantee = DeliveryGuarantee.AT_LEAST_ONCE,
        parallelism = 8,
        clickhouseUrl = "jdbc:clickhouse://localhost:8123/torghut",
        securityProtocol = "PLAINTEXT",
      )

    fun hashes(
      enabled: Boolean,
      topology: FlinkTaConfig = config,
      technical: Boolean = false,
      checkpoint: Boolean = false,
      restoreTopology: FeatureRestoreTopology = FeatureRestoreTopology.ROLLING_FEATURES,
    ): Map<String, Set<String>> {
      val env = StreamExecutionEnvironment.getExecutionEnvironment()
      env.parallelism = topology.parallelism
      val graph =
        configureTechnicalAnalysisJob(
          env,
          topology,
          if (enabled) {
            features.copy(
              technicalTopic = if (technical) "torghut.technical-features.v1" else null,
              restoreTopology = if (technical) restoreTopology else FeatureRestoreTopology.TA_ONLY,
            )
          } else {
            null
          },
        )
      val operators = graph.jobGraph.vertices.flatMap { it.operatorIDs }
      val identities = operators.map { (it.userDefinedOperatorID?.orElse(it.generatedOperatorID) ?: it.generatedOperatorID).toHexString() }
      assertEquals(identities.size, identities.toSet().size, "executable operators have unique restoration IDs")
      return operators
        .groupBy { it.userDefinedOperatorName ?: "<unnamed>" }
        .mapValues { (_, values) ->
          values
            .flatMap {
              if (checkpoint) {
                listOf(
                  it.generatedOperatorID.toHexString(),
                )
              } else {
                listOfNotNull(it.generatedOperatorID.toHexString(), it.userDefinedOperatorID?.orElse(null)?.toHexString())
              }
            }.toSet()
        }
    }
    val original = hashes(false)
    val extended = hashes(true)
    val technical = hashes(true, technical = true)
    val direct = hashes(true, technical = true, restoreTopology = FeatureRestoreTopology.TA_ONLY)
    hashes(false, checkpoint = true).forEach { (name, ids) ->
      assertTrue(direct[name]?.containsAll(ids) == true, "direct TA-only upgrade must restore: $name $ids")
    }
    hashes(true, checkpoint = true).forEach { (name, ids) ->
      assertTrue(technical[name]?.containsAll(ids) == true, "checkpoint generated IDs must restore: $name $ids")
    }
    assertTrue(
      technical["sink-signals-clickhouse: Writer"]?.contains("f522e4fa3e4594331e6c92266d1a35bf") == true,
      "restore the writer ID observed in the deployed savepoint",
    )
    val legacyStatefulOperators =
      mapOf(
        "Source: ta-trades-source" to "cbc357ccb763df2852fee8c4fc7d55f2",
        "Source: ta-quotes-source" to "6cdc5bb954874d922eaee11a8e7b5dd5",
        "Source: ta-bars1m-source" to "2963852293169ba90d9d1e7d6308db5c",
        "Source: Collection Source" to "3ba1d27b7fde4848a86e865c6c402dfa",
        "ta-microbars" to "759f6f8aaabcc9e34877eafd7b5a26b0",
        "ta-signals" to "9db4013e5109b317e88179afc722b038",
        "ta-signals-1m" to "7776e8278e4be1960c6bab94fa1d2351",
        "ta-status" to "e28c8a6b06f9feb6a843568d47ab400c",
        "sink-status: Writer" to "e5cfa2bc87fe7b8e92e96bd6602b4d0b",
        "sink-status: Committer" to "5d71b12a7a56f6985fb325232be40a09",
        "sink-microbars: Writer" to "e4bc7f01635098c4ae0b1f942a5d2415",
        "sink-microbars: Committer" to "7ab87194ebe8f64ee886853d6d717afc",
        "sink-signals: Writer" to "2130d69e4df764c48f34890ea8460f41",
        "sink-signals: Committer" to "18c31c3e59d4fe254b7f77bf4dc76d0b",
        "sink-microbars-clickhouse: Writer" to "962435e84a402a5c1afe2404c2ba6d61",
        "sink-microbars-clickhouse: Committer" to "ef9ced9882220cd98a99712bd2154275",
        "sink-signals-clickhouse: Writer" to "b14d3a8c3cd481d8808ff0e47332b6d5",
        "sink-signals-clickhouse: Committer" to "e865e52cedaec14d9a684b97f1bfa88c",
      )
    legacyStatefulOperators.forEach { (name, id) -> assertEquals(setOf(id), original[name], "legacy operator: $name") }
    assertTrue(extended.values.flatten().size > original.values.flatten().size)
    original.forEach { (name, hashes) -> assertTrue(extended[name]?.containsAll(hashes) == true, "savepoint operator: $name") }
    for (topology in listOf(
      config.copy(clickhouseUrl = null),
      config.copy(statusTopic = null),
      config.copy(quotesTopic = null, bars1mTopic = null, statusTopic = null, clickhouseUrl = null),
    )) {
      val previous = hashes(false, topology)
      val current = hashes(true, topology)
      val upgraded = hashes(true, topology, technical = true)
      val directUpgrade = hashes(true, topology, technical = true, restoreTopology = FeatureRestoreTopology.TA_ONLY)
      hashes(false, topology, checkpoint = true).forEach { (name, ids) ->
        assertTrue(directUpgrade[name]?.containsAll(ids) == true, "optional direct upgrade operator: $name $ids")
      }
      hashes(true, topology, checkpoint = true).forEach { (name, ids) ->
        assertTrue(upgraded[name]?.containsAll(ids) == true, "optional checkpoint operator: $name $ids")
      }
      previous.forEach { (name, ids) -> assertTrue(current[name]?.containsAll(ids) == true, "optional topology operator: $name") }
    }
  }

  @Test
  fun `technical features require explicit savepoint topology selection`() {
    val env =
      mapOf(
        "TA_MARKET_FEATURES_TOPIC" to "rolling",
        "TA_TECHNICAL_FEATURES_TOPIC" to "technical",
        "ARCHIVE_CORE_BARS_TOPIC" to "bars",
        "ARCHIVE_CORE_UNIVERSE_ID" to "test-equity-v1",
        "ARCHIVE_CORE_UNIVERSE_SYMBOLS" to "AAPL",
        "ARCHIVE_CORE_UNIVERSE_SYMBOL_HASH" to canonicalSymbolHash(listOf("AAPL")),
        "ARCHIVE_CORE_FEED" to "iex",
        "TORGHUT_TA_COMMIT" to "test-revision",
      )
    assertFailsWith<IllegalArgumentException> { RollingMarketFeatureConfig.fromEnv(env) }
    assertFailsWith<IllegalArgumentException> { RollingMarketFeatureConfig.fromEnv(env + ("TA_FEATURE_RESTORE_TOPOLOGY" to "unknown")) }
    for (topology in FeatureRestoreTopology.entries) {
      assertEquals(topology, RollingMarketFeatureConfig.fromEnv(env + ("TA_FEATURE_RESTORE_TOPOLOGY" to topology.name))?.restoreTopology)
    }
  }
}
