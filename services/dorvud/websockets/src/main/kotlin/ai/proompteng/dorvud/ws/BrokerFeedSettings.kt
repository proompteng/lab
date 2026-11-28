package ai.proompteng.dorvud.ws

import java.net.URI
import java.util.UUID

internal class BrokerFeedSettings(
  val connection: BrokerFeedConnection,
  val restateIngressUrl: String,
  val proxyUrl: String,
) {
  companion object {
    fun fromEnv(env: Map<String, String>): BrokerFeedSettings {
      fun required(name: String): String = requireNotNull(env[name]?.takeIf { it.isNotBlank() }) { "$name is required" }
      val accountId = required("BAYN_ALPACA_ACCOUNT_ID")
      require(UUID.fromString(accountId).toString() == accountId) { "broker account ID must be canonical" }
      require(required("BAYN_ALPACA_BASE_URL") == "https://paper-api.alpaca.markets") {
        "the verified broker feed requires the existing PAPER destination"
      }
      val revision = required("DORVUD_SOURCE_REVISION")
      require(revision.matches(Regex("[a-f0-9]{40}"))) { "broker feed source revision must be a Git commit" }
      val restateIngressUrl = required("RESTATE_INGRESS_URL")
      require(restateIngressUrl == "http://restate.restate.svc.cluster.local:8080") {
        "broker notifications require the internal Restate ingress"
      }
      val proxyUrl = required("BAYN_ALPACA_PROXY_URL")
      val proxy = URI(proxyUrl)
      require(
        proxy.scheme == "http" && proxy.host == "bayn-egress-proxy" && proxy.port == 3128 &&
          proxy.rawUserInfo == null && proxy.rawQuery == null && proxy.rawFragment == null && proxy.path.isEmpty(),
      ) { "broker feed requires the existing Bayn egress proxy" }
      return BrokerFeedSettings(
        BrokerFeedConnection(
          accountId = accountId,
          keyId = required("BAYN_ALPACA_KEY_ID"),
          secretKey = required("BAYN_ALPACA_SECRET_KEY"),
          sourceRevision = revision,
        ),
        restateIngressUrl,
        proxyUrl,
      )
    }
  }
}
