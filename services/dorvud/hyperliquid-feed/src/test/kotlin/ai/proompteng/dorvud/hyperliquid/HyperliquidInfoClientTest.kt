package ai.proompteng.dorvud.hyperliquid

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.HttpResponseData
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals

class HyperliquidInfoClientTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun `loads default and named perp dex markets`() =
    runTest {
      val requests = mutableListOf<String>()
      val client =
        HttpClient(
          MockEngine { request ->
            val body = (request.body as TextContent).text
            requests += body
            when {
              body.contains("perpDexs") -> jsonResponse("""[null,{"name":"test"}]""")
              body.contains(""""dex":"test"""") -> jsonResponse("""{"universe":[{"name":"COIN1","szDecimals":1}]}""")
              body.contains("meta") -> jsonResponse("""{"universe":[{"name":"BTC","szDecimals":5}]}""")
              body.contains("spotMeta") -> jsonResponse("""{"tokens":[],"universe":[]}""")
              else -> jsonResponse("""{}""")
            }
          },
        ) {
          install(ContentNegotiation) { json(json) }
        }
      val config =
        HyperliquidConfig.fromEnv(
          mapOf(
            "KAFKA_SASL_PASSWORD" to "secret",
            "CLICKHOUSE_ENABLED" to "false",
            "HYPERLIQUID_INCLUDE_SPOT" to "false",
          ),
        )
      val infoClient = HyperliquidInfoClient(config, client, MinuteWeightBudget(1000), json)

      val markets = infoClient.loadMarkets()

      assertEquals(listOf("hl:perp:default:BTC", "hl:perp:test:COIN1"), markets.map { it.marketId })
      assertEquals(3, requests.size)
    }

  private fun MockRequestHandleScope.jsonResponse(body: String): HttpResponseData =
    respond(
      content = body,
      status = HttpStatusCode.OK,
      headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
    )
}
