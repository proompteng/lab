package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.neo4j.Neo4jClient
import kotlinx.serialization.Serializable
import org.neo4j.driver.TransactionContext
import org.neo4j.driver.Value
import kotlin.math.max
import kotlin.math.min

interface GraphSnapshotProvider {
  suspend fun fetch(query: GraphContextQuery): GraphSnapshotReport
}

@Serializable
data class GraphContextQuery(
  val focus: String? = null,
  val nodeId: String? = null,
  val relationshipId: String? = null,
  val limit: Int? = null,
)

@Serializable
data class GraphSnapshotReport(
  val focus: String? = null,
  val sampleLimit: Int,
  val metrics: GraphMetrics,
  val sampledNodes: List<GraphNodeSummary> = emptyList(),
  val sampledRelationships: List<GraphRelationshipSummary> = emptyList(),
  val focusNode: GraphNodeSummary? = null,
  val focusRelationship: GraphRelationshipSummary? = null,
)

@Serializable
data class GraphMetrics(
  val totalNodes: Long,
  val totalRelationships: Long,
  val latestUpdate: String? = null,
  val labelHistogram: List<LabelFrequency> = emptyList(),
)

@Serializable
data class LabelFrequency(
  val label: String,
  val count: Long,
)

@Serializable
data class GraphNodeSummary(
  val id: String,
  val labels: List<String>,
  val properties: Map<String, String> = emptyMap(),
)

@Serializable
data class GraphRelationshipSummary(
  val id: String,
  val type: String,
  val fromId: String,
  val toId: String,
  val properties: Map<String, String> = emptyMap(),
)

class Neo4jGraphSnapshotProvider(
  private val neo4j: Neo4jClient,
  private val defaultLimit: Int,
) : GraphSnapshotProvider {
  override suspend fun fetch(query: GraphContextQuery): GraphSnapshotReport {
    val normalizedFocus =
      query.focus
        ?.trim()
        ?.lowercase()
        ?.takeIf { it.isNotEmpty() }
    val limit = clampLimit(query.limit)
    return neo4j.executeRead { tx ->
      val metrics = fetchMetrics(tx)
      val sampledNodes = fetchNodes(tx, normalizedFocus, limit)
      val sampledRelationships = fetchRelationships(tx, normalizedFocus, limit)
      val nodeDetail = query.nodeId?.let { fetchNodeById(tx, it) }
      val relationshipDetail = query.relationshipId?.let { fetchRelationshipById(tx, it) }
      GraphSnapshotReport(
        focus = normalizedFocus,
        sampleLimit = limit,
        metrics = metrics,
        sampledNodes = sampledNodes,
        sampledRelationships = sampledRelationships,
        focusNode = nodeDetail,
        focusRelationship = relationshipDetail,
      )
    }
  }

  private fun clampLimit(limit: Int?): Int = min(max(limit ?: defaultLimit, 1), 200)

  private fun fetchMetrics(tx: TransactionContext): GraphMetrics {
    val nodeRecord =
      tx
        .run(
          """
          MATCH (n)
          WHERE coalesce(n.deletedAt, '') = ''
          RETURN count(n) AS total, max(coalesce(n.updatedAt, n.createdAt)) AS latest
          """.trimIndent(),
        ).single()
    val relationshipRecord =
      tx
        .run(
          """
          MATCH ()-[r]-()
          WHERE coalesce(r.deletedAt, '') = ''
          RETURN count(r) AS total
          """.trimIndent(),
        ).single()
    val labelRecords =
      tx
        .run(
          """
          MATCH (n)
          WHERE coalesce(n.deletedAt, '') = ''
          UNWIND labels(n) AS label
          RETURN toString(label) AS label, count(*) AS count
          ORDER BY count DESC
          LIMIT 10
          """.trimIndent(),
        ).list()
    val histogram =
      labelRecords.map { LabelFrequency(label = it["label"].asString(), count = it["count"].asLong()) }
    val latestValue = nodeRecord["latest"]
    return GraphMetrics(
      totalNodes = nodeRecord["total"].asLong(),
      totalRelationships = relationshipRecord["total"].asLong(),
      latestUpdate = if (latestValue.isNull) null else latestValue.asString(),
      labelHistogram = histogram,
    )
  }

  private fun fetchNodes(
    tx: TransactionContext,
    focus: String?,
    limit: Int,
  ): List<GraphNodeSummary> {
    val focusClause =
      if (focus != null) {
        """
        AND (
          any(label IN labels(n) WHERE toLower(label) CONTAINS ${'$'}focus)
          OR toLower(coalesce(n.id, '')) CONTAINS ${'$'}focus
          OR any(key IN keys(n) WHERE toLower(toString(n[key])) CONTAINS ${'$'}focus)
        )
        """
      } else {
        ""
      }
    val query =
      """
      MATCH (n)
      WHERE coalesce(n.deletedAt, '') = ''
      $focusClause
      RETURN n.id AS id, labels(n) AS labels, properties(n) AS props
      ORDER BY coalesce(n.updatedAt, n.createdAt, '') DESC
      LIMIT ${'$'}limit
      """.trimIndent()
    val records = tx.run(query, mapOf("focus" to focus, "limit" to limit)).list()
    return records.mapNotNull { record ->
      val id = record["id"].asStringOrNull() ?: return@mapNotNull null
      GraphNodeSummary(
        id = id,
        labels = record["labels"].asList { value -> value.asString() },
        properties = record["props"].asMapOfStrings(),
      )
    }
  }

  private fun fetchRelationships(
    tx: TransactionContext,
    focus: String?,
    limit: Int,
  ): List<GraphRelationshipSummary> {
    val focusClause =
      if (focus != null) {
        """
        AND (
          toLower(coalesce(r.id, '')) CONTAINS ${'$'}focus
          OR toLower(type(r)) CONTAINS ${'$'}focus
          OR any(key IN keys(r) WHERE toLower(toString(r[key])) CONTAINS ${'$'}focus)
        )
        """
      } else {
        ""
      }
    val query =
      """
      MATCH (a)-[r]->(b)
      WHERE coalesce(r.deletedAt, '') = ''
      $focusClause
      RETURN r.id AS id, type(r) AS type, a.id AS fromId, b.id AS toId, properties(r) AS props
      ORDER BY coalesce(r.updatedAt, r.createdAt, '') DESC
      LIMIT ${'$'}limit
      """.trimIndent()
    val records = tx.run(query, mapOf("focus" to focus, "limit" to limit)).list()
    return records.mapNotNull { record ->
      val id = record["id"].asStringOrNull() ?: return@mapNotNull null
      GraphRelationshipSummary(
        id = id,
        type = record["type"].asString(),
        fromId = record["fromId"].asStringOrNull() ?: "?",
        toId = record["toId"].asStringOrNull() ?: "?",
        properties = record["props"].asMapOfStrings(),
      )
    }
  }

  private fun fetchNodeById(
    tx: TransactionContext,
    id: String,
  ): GraphNodeSummary? {
    val record =
      tx
        .run(
          """
          MATCH (n { id: ${'$'}id })
          RETURN n.id AS id, labels(n) AS labels, properties(n) AS props
          """.trimIndent(),
          mapOf("id" to id),
        ).list()
        .firstOrNull() ?: return null
    return GraphNodeSummary(
      id = record["id"].asString(),
      labels = record["labels"].asList { value -> value.asString() },
      properties = record["props"].asMapOfStrings(),
    )
  }

  private fun fetchRelationshipById(
    tx: TransactionContext,
    id: String,
  ): GraphRelationshipSummary? {
    val record =
      tx
        .run(
          """
          MATCH (a)-[r { id: ${'$'}id }]->(b)
          RETURN r.id AS id, type(r) AS type, a.id AS fromId, b.id AS toId, properties(r) AS props
          """.trimIndent(),
          mapOf("id" to id),
        ).list()
        .firstOrNull() ?: return null
    return GraphRelationshipSummary(
      id = record["id"].asString(),
      type = record["type"].asString(),
      fromId = record["fromId"].asStringOrNull() ?: "?",
      toId = record["toId"].asStringOrNull() ?: "?",
      properties = record["props"].asMapOfStrings(),
    )
  }
}

private fun Value?.asStringOrNull(): String? = this?.takeUnless { it.isNull }?.asString()

private fun Value?.asMapOfStrings(): Map<String, String> =
  this?.asMap()?.mapValues { (_, value) -> formatValue(value) }?.filterValues { it.isNotEmpty() } ?: emptyMap()

private fun formatValue(value: Any?): String =
  when (value) {
    null -> ""
    is Iterable<*> -> value.joinToString(prefix = "[", postfix = "]") { formatValue(it) }
    is Map<*, *> -> value.entries.joinToString(prefix = "{", postfix = "}") { (k, v) -> "$k=${formatValue(v)}" }
    else -> value.toString()
  }.take(512)
