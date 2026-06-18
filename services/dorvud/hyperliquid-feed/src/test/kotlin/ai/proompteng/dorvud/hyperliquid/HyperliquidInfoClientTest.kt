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

  @Test
  fun `selects top markets by public twenty four hour notional volume`() =
    runTest {
      val client =
        HttpClient(
          MockEngine { request ->
            val body = (request.body as TextContent).text
            when {
              body.hasType("perpDexs") -> jsonResponse("""[null,{"name":"test"}]""")
              body.hasType("metaAndAssetCtxs") && body.contains(""""dex":"test"""") ->
                jsonResponse(
                  """
                  [
                    {"universe":[{"name":"COIN1","szDecimals":1},{"name":"COIN2","szDecimals":1}]},
                    [{"dayNtlVlm":"3000.25"},{"dayNtlVlm":"5"}]
                  ]
                  """.trimIndent(),
                )
              body.hasType("metaAndAssetCtxs") ->
                jsonResponse(
                  """
                  [
                    {"universe":[{"name":"BTC","szDecimals":5},{"name":"ETH","szDecimals":4}]},
                    [{"dayNtlVlm":"1000"},{"dayNtlVlm":"25"}]
                  ]
                  """.trimIndent(),
                )
              body.hasType("meta") && body.contains(""""dex":"test"""") ->
                jsonResponse("""{"universe":[{"name":"COIN1","szDecimals":1},{"name":"COIN2","szDecimals":1}]}""")
              body.hasType("meta") ->
                jsonResponse("""{"universe":[{"name":"BTC","szDecimals":5},{"name":"ETH","szDecimals":4}]}""")
              body.hasType("spotMetaAndAssetCtxs") ->
                jsonResponse(
                  """
                  [
                    {"tokens":[],"universe":[{"name":"PURR/USDC","tokens":[0,1],"index":0},{"name":"@1","tokens":[2,1],"index":1}]},
                    [{"dayNtlVlm":"2000"},{"dayNtlVlm":"10"}]
                  ]
                  """.trimIndent(),
                )
              body.hasType("spotMeta") ->
                jsonResponse(
                  """
                  {
                    "tokens": [],
                    "universe": [
                      {"name":"PURR/USDC","tokens":[0,1],"index":0},
                      {"name":"@1","tokens":[2,1],"index":1}
                    ]
                  }
                  """.trimIndent(),
                )
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
            "HYPERLIQUID_MARKET_COVERAGE" to "top-volume",
            "HYPERLIQUID_TOP_MARKET_COUNT" to "3",
          ),
        )
      val infoClient = HyperliquidInfoClient(config, client, MinuteWeightBudget(1000), json)

      val markets = infoClient.loadMarkets()

      assertEquals(
        listOf("hl:perp:test:COIN1", "hl:spot:0:PURR/USDC", "hl:perp:default:BTC"),
        markets.map { it.marketId },
      )
    }

  private fun MockRequestHandleScope.jsonResponse(body: String): HttpResponseData =
    respond(
      content = body,
      status = HttpStatusCode.OK,
      headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
    )

  private fun String.hasType(type: String): Boolean = contains(""""type":"$type"""")
}
