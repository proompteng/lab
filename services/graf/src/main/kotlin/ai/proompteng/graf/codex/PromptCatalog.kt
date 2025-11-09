package ai.proompteng.graf.codex

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream

@Serializable
data class PromptInputSpec(
  val name: String,
  val description: String,
  val required: Boolean,
  val example: String? = null,
)

@Serializable
data class PromptEntityExpectation(
  val label: String,
  val description: String,
  val requiredProperties: List<String> = emptyList(),
)

@Serializable
data class PromptRelationshipExpectation(
  val type: String,
  val description: String,
  val fromLabel: String,
  val toLabel: String,
  val requiredProperties: List<String> = emptyList(),
)

@Serializable
data class PromptExpectedArtifact(
  val entities: List<PromptEntityExpectation>,
  val relationships: List<PromptRelationshipExpectation>,
)

@Serializable
data class PromptCitations(
  val required: List<String>,
  val preferredSources: List<String>,
  val notes: String? = null,
  val minimumCount: Int = 0,
)

@Serializable
data class PromptScoring(
  val metric: String,
  val target: String,
  val notes: String? = null,
)

@Serializable
data class PromptCatalogDefinition(
  val promptId: String,
  val streamId: String,
  val objective: String,
  val schemaVersion: Int,
  val prompt: String,
  val inputs: List<PromptInputSpec>,
  val expectedArtifact: PromptExpectedArtifact,
  val citations: PromptCitations,
  val scoringHeuristics: List<PromptScoring>,
  val metadata: Map<String, String> = emptyMap(),
)

class PromptCatalog(private val definitions: Map<String, PromptCatalogDefinition>) {
  fun findById(promptId: String): PromptCatalogDefinition? = definitions[promptId]

  fun requireById(promptId: String): PromptCatalogDefinition =
    definitions[promptId] ?: throw IllegalArgumentException("Unknown promptId $promptId")
}

@OptIn(ExperimentalSerializationApi::class)
object PromptCatalogLoader {
  private val promptFiles =
    listOf(
      "foundries.json",
      "odm-ems.json",
      "logistics-ports.json",
      "research-partners.json",
      "financing-risk.json",
      "instrumentation-vendors.json",
    )

  fun loadCatalog(json: Json): PromptCatalog {
    val definitions = promptFiles.map { fileName ->
      val resource = PromptCatalogLoader::class.java.classLoader
        .getResourceAsStream("nvidia-prompts/$fileName")
        ?: error("Missing prompt catalog resource: $fileName")
      resource.use { stream ->
        json.decodeFromStream<PromptCatalogDefinition>(stream)
      }
    }
    val duplicates = definitions.groupBy { it.promptId }.filter { it.value.size > 1 }.keys
    require(duplicates.isEmpty()) { "Duplicate promptId(s) in catalog: $duplicates" }
    return PromptCatalog(definitions.associateBy { it.promptId })
  }
}
