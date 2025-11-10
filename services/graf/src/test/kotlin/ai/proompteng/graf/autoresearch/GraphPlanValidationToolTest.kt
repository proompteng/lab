package ai.proompteng.graf.autoresearch

import ai.proompteng.graf.model.GraphRelationshipPlan
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class GraphPlanValidationToolTest {
  private val json = Json { ignoreUnknownKeys = false }
  private val tool = GraphPlanValidationTool(json)

  @Test
  fun `validator returns normalized json`() =
    runBlocking {
      val plan =
        GraphRelationshipPlan(
          objective = "Test",
          summary = "Summary",
          candidateRelationships = emptyList(),
        )
      val input =
        GraphPlanValidationTool.Args(
          planJson = json.encodeToString(GraphRelationshipPlan.serializer(), plan),
        )

      val output = tool.doExecute(input)

      assertEquals(input.planJson, output)
    }

  @Test
  fun `validator throws on invalid payload`() =
    runBlocking {
      val input = GraphPlanValidationTool.Args(planJson = """{"objective":123}""")

      assertFailsWith<IllegalArgumentException> { tool.doExecute(input) }
    }
}
