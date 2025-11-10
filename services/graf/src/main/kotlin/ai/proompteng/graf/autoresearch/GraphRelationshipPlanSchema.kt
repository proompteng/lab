package ai.proompteng.graf.autoresearch

import ai.koog.prompt.params.LLMParams
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

object GraphRelationshipPlanSchema {
  const val SCHEMA_NAME = "graph_relationship_plan"

  val json: JsonObject = buildPlanSchema()

  val llmSchema: LLMParams.Schema.JSON =
    LLMParams.Schema.JSON.Standard(
      name = SCHEMA_NAME,
      schema = json,
    )

  private fun buildPlanSchema(): JsonObject {
    val stringValue = stringSchema()
    val stringArray = stringArraySchema()
    val candidateRelationshipSchema = buildCandidateRelationshipSchema()
    return buildJsonObject {
      put("type", "object")
      putJsonArray("required") {
        add("objective")
        add("summary")
        add("currentSignals")
        add("candidateRelationships")
        add("prioritizedPrompts")
        add("missingData")
        add("recommendedTools")
      }
      putJsonObject("properties") {
        put("objective", stringValue)
        put("summary", stringSchema(minLength = 1))
        put("currentSignals", stringArray)
        put(
          "candidateRelationships",
          buildJsonObject {
            put("type", "array")
            put("items", candidateRelationshipSchema)
            put("default", JsonArray(emptyList()))
          },
        )
        put("prioritizedPrompts", stringArray)
        put("missingData", stringArray)
        put("recommendedTools", stringArray)
      }
      put("additionalProperties", false)
    }
  }

  private fun buildCandidateRelationshipSchema(): JsonObject =
    buildJsonObject {
      put("type", "object")
      putJsonArray("required") {
        add("fromId")
        add("toId")
        add("relationshipType")
        add("rationale")
        add("confidence")
        add("requiredEvidence")
        add("suggestedArtifacts")
      }
      putJsonObject("properties") {
        put("fromId", stringSchema())
        put("toId", stringSchema())
        put("relationshipType", stringSchema())
        put("rationale", stringSchema())
        put(
          "confidence",
          buildJsonObject {
            put("type", "string")
            putJsonArray("enum") {
              add("low")
              add("medium")
              add("high")
            }
          },
        )
        put("requiredEvidence", stringArraySchema())
        put("suggestedArtifacts", stringArraySchema())
      }
      put("additionalProperties", false)
    }

  private fun stringSchema(minLength: Int = 1): JsonObject =
    buildJsonObject {
      put("type", "string")
      put("minLength", minLength)
    }

  private fun stringArraySchema(): JsonObject =
    buildJsonObject {
      put("type", "array")
      putJsonObject("items") { put("type", "string") }
      put("default", JsonArray(emptyList()))
    }
}
