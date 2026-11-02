package ai.proompteng.graf.services

import ai.proompteng.graf.model.BatchResponse
import ai.proompteng.graf.model.CleanRequest
import ai.proompteng.graf.model.CleanResponse
import ai.proompteng.graf.model.ComplementRequest
import ai.proompteng.graf.model.ComplementResponse
import ai.proompteng.graf.model.DeleteRequest
import ai.proompteng.graf.model.EntityBatchRequest
import ai.proompteng.graf.model.EntityPatchRequest
import ai.proompteng.graf.model.EntityRequest
import ai.proompteng.graf.model.GraphResponse
import ai.proompteng.graf.model.RelationshipBatchRequest
import ai.proompteng.graf.model.RelationshipPatchRequest
import ai.proompteng.graf.model.RelationshipRequest
import ai.proompteng.graf.neo4j.Neo4jClient
import ai.proompteng.graf.telemetry.GrafTelemetry
import io.opentelemetry.api.common.AttributeKey
import io.opentelemetry.api.common.Attributes
import io.opentelemetry.api.trace.Span
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import mu.KotlinLogging
import java.lang.IllegalArgumentException
import java.time.Duration
import java.time.Instant
import java.util.UUID

private val identifierPattern = Regex("^[A-Za-z][A-Za-z0-9_]*$")

interface GraphPersistence {
  suspend fun upsertEntities(request: EntityBatchRequest): BatchResponse

  suspend fun upsertRelationships(request: RelationshipBatchRequest): BatchResponse
}

class GraphService(
  private val neo4j: Neo4jClient,
) : GraphPersistence {
  private val logger = KotlinLogging.logger {}

  suspend fun warmup() {
    runCatching {
      neo4j.executeRead { tx ->
        tx.run("RETURN 1 AS ok").consume()
      }
    }.onFailure { error ->
      logger.warn(error) { "Graf Neo4j warmup query failed; continuing with lazy initialization" }
    }
  }

  override suspend fun upsertEntities(request: EntityBatchRequest): BatchResponse =
    GrafTelemetry.withSpan(
      "graf.graph.upsertEntities",
      Attributes
        .builder()
        .put(AttributeKey.longKey("graf.batch.size"), request.entities.size.toLong())
        .build(),
    ) {
      require(request.entities.isNotEmpty()) { "entities payload must include at least one entry" }
      GrafTelemetry.recordBatchSize(
        request.entities.size,
        request.entities.firstOrNull()?.artifactId,
        request.entities.firstOrNull()?.researchSource,
      )
      val batchStart = System.nanoTime()
      val response = upsertEntitiesBatch(request.entities)
      val durationMs = (System.nanoTime() - batchStart) / 1_000_000
      recordBatchTelemetry(
        durationMs,
        request.entities.size,
        "entities",
        request.entities.firstOrNull()?.artifactId,
        request.entities.firstOrNull()?.researchSource,
      )
      response
    }

  override suspend fun upsertRelationships(request: RelationshipBatchRequest): BatchResponse =
    GrafTelemetry.withSpan(
      "graf.graph.upsertRelationships",
      Attributes
        .builder()
        .put(AttributeKey.longKey("graf.batch.size"), request.relationships.size.toLong())
        .build(),
    ) {
      require(request.relationships.isNotEmpty()) { "relationships payload must include at least one entry" }
      GrafTelemetry.recordBatchSize(
        request.relationships.size,
        request.relationships.firstOrNull()?.artifactId,
        request.relationships.firstOrNull()?.researchSource,
      )
      val batchStart = System.nanoTime()
      val response = upsertRelationshipsBatch(request.relationships)
      val durationMs = (System.nanoTime() - batchStart) / 1_000_000
      recordBatchTelemetry(
        durationMs,
        request.relationships.size,
        "relationships",
        request.relationships.firstOrNull()?.artifactId,
        request.relationships.firstOrNull()?.researchSource,
      )
      response
    }

  suspend fun patchEntity(
    id: String,
    request: EntityPatchRequest,
  ): GraphResponse =
    GrafTelemetry.withSpan(
      "graf.graph.patchEntity",
      Attributes
        .builder()
        .put(AttributeKey.stringKey("entity.id"), id)
        .apply {
          request.artifactId?.let { put(AttributeKey.stringKey("artifact.id"), it) }
        }.build(),
    ) {
      require(id.isNotBlank()) { "entity id must be provided" }
      val hasChanges = request.set.isNotEmpty() || request.remove.isNotEmpty()
      require(hasChanges) { "patch payload must set or remove properties" }
      neo4j.executeWrite("patchEntity") { tx ->
        val props = request.set.toValueMap().toMutableMap()
        request.artifactId?.also { props["artifactId"] = it }
        request.researchSource?.also { props["researchSource"] = it }
        props["updatedAt"] = Instant.now().toString()
        val sanitizedRemovals = request.remove.filter { it.isNotBlank() }.map { it.ensurePropertyName() }
        val queryLines = mutableListOf<String>()
        val params = mutableMapOf<String, Any?>("id" to id)
        if (props.isNotEmpty()) {
          queryLines += "SET n += ${'$'}props"
          params["props"] = props.filterValues { it != null }
        }
        if (sanitizedRemovals.isNotEmpty()) {
          queryLines += "REMOVE ${sanitizedRemovals.joinToString(", ") { "n.$it" }}"
        }
        if (queryLines.isEmpty()) {
          throw IllegalArgumentException("patch payload did not change anything")
        }
        val query =
          buildString {
            append("MATCH (n { id: ${'$'}id })\n")
            append(queryLines.joinToString("\n"))
            append("\nRETURN n.id AS id")
          }
        val records = tx.run(query, params).list()
        val record = records.firstOrNull() ?: throw IllegalArgumentException("entity $id not found")
        GraphResponse(record["id"].asString(), "entity patched", request.artifactId)
      }
    }

  suspend fun patchRelationship(
    id: String,
    request: RelationshipPatchRequest,
  ): GraphResponse =
    GrafTelemetry.withSpan(
      "graf.graph.patchRelationship",
      Attributes
        .builder()
        .put(AttributeKey.stringKey("relationship.id"), id)
        .apply {
          request.artifactId?.let { put(AttributeKey.stringKey("artifact.id"), it) }
        }.build(),
    ) {
      require(id.isNotBlank()) { "relationship id must be provided" }
      val hasChanges = request.set.isNotEmpty() || request.remove.isNotEmpty()
      require(hasChanges) { "patch payload must set or remove properties" }
      neo4j.executeWrite("patchRelationship") { tx ->
        val props = request.set.toValueMap().toMutableMap()
        request.artifactId?.also { props["artifactId"] = it }
        request.researchSource?.also { props["researchSource"] = it }
        props["updatedAt"] = Instant.now().toString()
        val sanitized = request.remove.filter { it.isNotBlank() }.map { it.ensurePropertyName() }
        val queryLines = mutableListOf<String>()
        val params = mutableMapOf<String, Any?>("id" to id)
        if (props.isNotEmpty()) {
          queryLines += "SET r += ${'$'}props"
          params["props"] = props.filterValues { it != null }
        }
        if (sanitized.isNotEmpty()) {
          queryLines += "REMOVE ${sanitized.joinToString(", ") { "r.$it" }}"
        }
        if (queryLines.isEmpty()) {
          throw IllegalArgumentException("patch payload did not change anything")
        }
        val query =
          buildString {
            append("MATCH ()-[r { id: ${'$'}id }]-()\n")
            append(queryLines.joinToString("\n"))
            append("\nRETURN r.id AS id")
          }
        val records = tx.run(query, params).list()
        val record = records.firstOrNull() ?: throw IllegalArgumentException("relationship $id not found")
        GraphResponse(record["id"].asString(), "relationship patched", request.artifactId)
      }
    }

  suspend fun deleteEntity(
    id: String,
    request: DeleteRequest,
  ): GraphResponse =
    GrafTelemetry.withSpan(
      "graf.graph.deleteEntity",
      Attributes
        .builder()
        .put(AttributeKey.stringKey("entity.id"), id)
        .apply {
          request.artifactId?.let { put(AttributeKey.stringKey("artifact.id"), it) }
        }.build(),
    ) {
      require(id.isNotBlank()) { "entity id must be provided" }
      neo4j.executeWrite("deleteEntity") { tx ->
        val query =
          buildString {
            appendLine("MATCH (n { id: ${'$'}id })")
            appendLine("SET n.deletedAt = ${'$'}now,")
            appendLine("    n.deletedArtifactId = ${'$'}artifactId,")
            appendLine("    n.deletedReason = ${'$'}reason")
            append("RETURN n.id AS id")
          }
        val params =
          mapOf(
            "id" to id,
            "now" to Instant.now().toString(),
            "artifactId" to request.artifactId,
            "reason" to request.reason,
          )
        val records = tx.run(query, params).list()
        val record = records.firstOrNull() ?: throw IllegalArgumentException("entity $id not found")
        GraphResponse(record["id"].asString(), "entity marked deleted", request.artifactId)
      }
    }

  suspend fun deleteRelationship(
    id: String,
    request: DeleteRequest,
  ): GraphResponse =
    GrafTelemetry.withSpan(
      "graf.graph.deleteRelationship",
      Attributes
        .builder()
        .put(AttributeKey.stringKey("relationship.id"), id)
        .apply {
          request.artifactId?.let { put(AttributeKey.stringKey("artifact.id"), it) }
        }.build(),
    ) {
      require(id.isNotBlank()) { "relationship id must be provided" }
      neo4j.executeWrite("deleteRelationship") { tx ->
        val query =
          buildString {
            appendLine("MATCH ()-[r { id: ${'$'}id }]-()")
            appendLine("SET r.deletedAt = ${'$'}now,")
            appendLine("    r.deletedArtifactId = ${'$'}artifactId,")
            appendLine("    r.deletedReason = ${'$'}reason")
            append("RETURN r.id AS id")
          }
        val params =
          mapOf(
            "id" to id,
            "now" to Instant.now().toString(),
            "artifactId" to request.artifactId,
            "reason" to request.reason,
          )
        val records = tx.run(query, params).list()
        val record = records.firstOrNull() ?: throw IllegalArgumentException("relationship $id not found")
        GraphResponse(record["id"].asString(), "relationship marked deleted", request.artifactId)
      }
    }

  suspend fun complement(request: ComplementRequest): ComplementResponse =
    GrafTelemetry.withSpan(
      "graf.graph.complement",
      Attributes
        .builder()
        .put(AttributeKey.stringKey("entity.id"), request.id)
        .apply {
          request.artifactId?.let { put(AttributeKey.stringKey("artifact.id"), it) }
        }.build(),
    ) {
      require(request.hints.isNotEmpty()) { "hints map cannot be empty" }
      neo4j.executeWrite("complement") { tx ->
        val hints = request.hints.toValueMap().toMutableMap()
        hints["complementedAt"] = Instant.now().toString()
        request.artifactId?.also { hints["artifactId"] = it }
        val params = mapOf("id" to request.id, "hints" to hints.filterValues { it != null })
        val query =
          buildString {
            appendLine("MATCH (n { id: ${'$'}id })")
            appendLine("SET n += ${'$'}hints")
            append("RETURN n.id AS id")
          }
        val record =
          tx.run(query, params).list().firstOrNull()
            ?: throw IllegalArgumentException("entity ${request.id} not found")
        ComplementResponse(record["id"].asString(), "entity complemented", request.artifactId)
      }
    }

  suspend fun clean(request: CleanRequest): CleanResponse =
    GrafTelemetry.withSpan(
      "graf.graph.clean",
      Attributes
        .builder()
        .apply {
          request.artifactId?.let { put(AttributeKey.stringKey("artifact.id"), it) }
          request.olderThanHours?.toLong()?.let { put(AttributeKey.longKey("graf.clean.older_than_hours"), it) }
        }.build(),
    ) {
      neo4j.executeWrite("clean") { tx ->
        val now = Instant.now().toString()
        val params = mutableMapOf<String, Any?>("now" to now)
        val whereClause =
          when {
            !request.artifactId.isNullOrBlank() -> {
              params["artifactId"] = request.artifactId
              "WHERE n.artifactId = ${'$'}artifactId"
            }
            request.olderThanHours != null && request.olderThanHours > 0 -> {
              val threshold = Instant.now().minus(Duration.ofHours(request.olderThanHours.toLong())).toString()
              params["threshold"] = threshold
              "WHERE datetime(n.updatedAt) <= datetime(${ '$'}threshold)"
            }
            else -> "WHERE exists(n.deletedAt)"
          }
        val query =
          buildString {
            appendLine("MATCH (n)")
            appendLine(whereClause)
            appendLine("SET n.cleanedAt = ${'$'}now")
            append("RETURN count(n) AS affected")
          }
        val record = tx.run(query, params).single()
        CleanResponse(record["affected"].asLong(), "clean run recorded")
      }
    }

  private suspend fun upsertEntitiesBatch(entities: List<EntityRequest>): BatchResponse =
    neo4j.executeWrite("upsertEntitiesBatch") { tx ->
      val rows =
        entities.map { entity ->
          val label = entity.resolveLabel().ensureIdentifier("label")
          val entityId = entity.id.takeUnless { it.isNullOrBlank() } ?: UUID.randomUUID().toString()
          val props =
            entity.properties.toValueMap().toMutableMap().apply {
              entity.name?.takeIf { it.isNotBlank() }?.let { name ->
                putIfAbsent("name", name)
              }
              this["artifactId"] = entity.artifactId
              this["researchSource"] = entity.researchSource
              this["streamId"] = entity.streamId
              this["updatedAt"] = Instant.now().toString()
              this["id"] = entityId
            }
          EntityBatchRow(entityId, label, props.filterValues { it != null }, entity.artifactId)
        }
      rows.groupBy { it.label }.forEach { (label, batchRows) ->
        val params =
          mapOf(
            "rows" to
              batchRows.map { row ->
                mapOf(
                  "id" to row.id,
                  "props" to row.props,
                )
              },
          )
        val query =
          buildString {
            appendLine("UNWIND ${'$'}rows AS row")
            appendLine("MERGE (n:$label { id: row.id })")
            appendLine("SET n += row.props")
            append("RETURN row.id AS id")
          }
        val records = tx.run(query, params).list()
        if (records.size != batchRows.size) {
          throw IllegalStateException("entity batch for label $label returned ${records.size} of ${batchRows.size} rows")
        }
      }
      BatchResponse(rows.map { GraphResponse(it.id, "entity upserted", it.artifactId) })
    }

  private fun EntityRequest.resolveLabel(): String =
    label?.takeIf { it.isNotBlank() } ?: type?.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException(
      "entity label must be provided",
    )

  private suspend fun upsertRelationshipsBatch(relationships: List<RelationshipRequest>): BatchResponse =
    neo4j.executeWrite("upsertRelationshipsBatch") { tx ->
      val rows =
        relationships.map { request ->
          val relType = request.type.ensureIdentifier("relationship type")
          val fromId = request.fromId.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("fromId must be provided")
          val toId = request.toId.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("toId must be provided")
          val relId = request.id.takeUnless { it.isNullOrBlank() } ?: UUID.randomUUID().toString()
          val props =
            request.properties.toValueMap().toMutableMap().apply {
              this["artifactId"] = request.artifactId
              this["researchSource"] = request.researchSource
              this["streamId"] = request.streamId
              this["updatedAt"] = Instant.now().toString()
              this["id"] = relId
            }
          RelationshipBatchRow(relId, relType, fromId, toId, props.filterValues { it != null }, request.artifactId)
        }
      rows.groupBy { it.type }.forEach { (type, batchRows) ->
        val params =
          mapOf(
            "rows" to
              batchRows.map { row ->
                mapOf(
                  "id" to row.id,
                  "fromId" to row.fromId,
                  "toId" to row.toId,
                  "props" to row.props,
                )
              },
          )
        val query =
          buildString {
            appendLine("UNWIND ${'$'}rows AS row")
            appendLine("MATCH (a { id: row.fromId }), (b { id: row.toId })")
            appendLine("MERGE (a)-[r:$type { id: row.id }]->(b)")
            appendLine("SET r += row.props")
            append("RETURN row.id AS id")
          }
        val records = tx.run(query, params).list()
        val returnedIds = records.map { it["id"].asString() }
        if (returnedIds.size != batchRows.size) {
          val missingId = batchRows.map { it.id }.firstOrNull { it !in returnedIds } ?: batchRows.first().id
          throw IllegalArgumentException("source or target node not found for relationship $missingId")
        }
      }
      BatchResponse(rows.map { GraphResponse(it.id, "relationship upserted", it.artifactId) })
    }

  private fun recordBatchTelemetry(
    durationMs: Long,
    recordCount: Int,
    operation: String,
    artifactId: String?,
    researchSource: String?,
  ) {
    val span = Span.current()
    span.setAttribute(AttributeKey.longKey("graf.batch.duration_ms"), durationMs)
    span.setAttribute(AttributeKey.longKey("graf.batch.record.count"), recordCount.toLong())
    span.setAttribute(AttributeKey.stringKey("graf.batch.operation"), operation)
    artifactId?.let { span.setAttribute(AttributeKey.stringKey("graf.batch.artifact.id"), it) }
    researchSource?.let { span.setAttribute(AttributeKey.stringKey("graf.batch.research.source"), it) }
    GrafTelemetry.recordGraphBatch(durationMs, recordCount, operation, artifactId, researchSource)
  }

  private data class EntityBatchRow(
    val id: String,
    val label: String,
    val props: Map<String, Any?>,
    val artifactId: String?,
  )

  private data class RelationshipBatchRow(
    val id: String,
    val type: String,
    val fromId: String,
    val toId: String,
    val props: Map<String, Any?>,
    val artifactId: String?,
  )
}

private fun Map<String, JsonElement>.toValueMap(): Map<String, Any?> = mapValues { it.value.toNodeValue() }.filterValues { it != null }

private fun JsonElement.toNodeValue(): Any? =
  when (this) {
    JsonNull -> null
    is JsonPrimitive -> {
      val text = content
      if (isString) {
        text
      } else {
        text.toBooleanStrictOrNull()
          ?: text.toLongOrNull()
          ?: text.toDoubleOrNull()
          ?: text
      }
    }
    is JsonObject -> this.mapValues { it.value.toNodeValue() }
    is JsonArray -> this.map { it.toNodeValue() }
  }

private fun String.ensureIdentifier(field: String): String {
  val candidate = trim().takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("$field cannot be blank")
  if (!identifierPattern.matches(candidate)) {
    throw IllegalArgumentException("$field must match /^[A-Za-z][A-Za-z0-9_]*$")
  }
  return candidate
}

private fun String.ensurePropertyName(): String = ensureIdentifier("property name")
