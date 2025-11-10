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
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
      val results = request.entities.map { upsertEntity(it) }
      BatchResponse(results)
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
      val results = request.relationships.map { upsertRelationship(it) }
      BatchResponse(results)
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

  private suspend fun upsertEntity(entity: EntityRequest): GraphResponse =
    neo4j.executeWrite("upsertEntity") { tx ->
      val label = entity.label.ensureIdentifier("label")
      val entityId = entity.id.takeUnless { it.isNullOrBlank() } ?: UUID.randomUUID().toString()
      val props = entity.properties.toValueMap().toMutableMap()
      props["artifactId"] = entity.artifactId
      props["researchSource"] = entity.researchSource
      props["streamId"] = entity.streamId
      props["updatedAt"] = Instant.now().toString()
      props["id"] = entityId
      val query =
        buildString {
          appendLine("MERGE (n:$label { id: ${'$'}id })")
          appendLine("SET n += ${'$'}props")
          append("RETURN n.id AS id")
        }
      val params = mapOf("id" to entityId, "props" to props.filterValues { it != null })
      val record = tx.run(query, params).single()
      GraphResponse(record["id"].asString(), "entity upserted", entity.artifactId)
    }

  private suspend fun upsertRelationship(request: RelationshipRequest): GraphResponse =
    neo4j.executeWrite("upsertRelationship") { tx ->
      val relType = request.type.ensureIdentifier("relationship type")
      val fromId = request.fromId.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("fromId must be provided")
      val toId = request.toId.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("toId must be provided")
      val relId = request.id.takeUnless { it.isNullOrBlank() } ?: UUID.randomUUID().toString()
      val props = request.properties.toValueMap().toMutableMap()
      props["artifactId"] = request.artifactId
      props["researchSource"] = request.researchSource
      props["streamId"] = request.streamId
      props["updatedAt"] = Instant.now().toString()
      props["id"] = relId
      val query =
        buildString {
          appendLine("MATCH (a { id: ${'$'}fromId }), (b { id: ${'$'}toId })")
          appendLine("MERGE (a)-[r:$relType { id: ${'$'}relId }]->(b)")
          appendLine("SET r += ${'$'}props")
          append("RETURN r.id AS id")
        }
      val params =
        mapOf(
          "fromId" to fromId,
          "toId" to toId,
          "relId" to relId,
          "props" to props.filterValues { it != null },
        )
      val records = tx.run(query, params).list()
      if (records.isEmpty()) {
        throw IllegalArgumentException("source or target node not found for relationship $relId")
      }
      val record = records.first()
      GraphResponse(record["id"].asString(), "relationship upserted", request.artifactId)
    }
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
