use anyhow::{Context, ensure};
use futures::{StreamExt, TryStreamExt, stream};
use k8s_openapi::api::core::v1::Secret;
use kube::{Api, Client};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub struct Authorizer {
    endpoint: String,
    http: reqwest::Client,
    kube: Client,
}
impl Authorizer {
    pub async fn ready(&self) -> anyhow::Result<()> {
        self.allowed_many(
            &"0".repeat(64),
            "00000000-0000-0000-0000-000000000000",
            &[("health".into(), "probe".into())],
        )
        .await?;
        Ok(())
    }
    pub fn new(kube: Client, endpoint: String) -> anyhow::Result<Self> {
        Ok(Self {
            endpoint,
            kube,
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(3))
                .build()?,
        })
    }
    pub async fn allowed(
        &self,
        owner: &str,
        agent_uid: &str,
        connector: &str,
        tool: &str,
    ) -> anyhow::Result<bool> {
        let key = self.key().await?;
        let mut request = check_item(owner, agent_uid, connector, tool);
        request["consistency"] = json!({"fullyConsistent": true});
        let result = self.post("check", &key, &request, 65536).await?;
        decision(&result)
    }
    pub async fn allowed_many(
        &self,
        owner: &str,
        agent_uid: &str,
        checks: &[(String, String)],
    ) -> anyhow::Result<Vec<bool>> {
        ensure!(checks.len() <= 8192, "too many authorization checks");
        if checks.is_empty() {
            return Ok(Vec::new());
        }
        let key = self.key().await?;
        let key = &key;
        let items: Vec<Value> = checks
            .iter()
            .map(|(connector, tool)| check_item(owner, agent_uid, connector, tool))
            .collect();
        // At the catalog limit this is 32 requests, with at most four in flight. No decisions are cached.
        let batches: Vec<(usize, Vec<bool>)> = stream::iter(
            items
                .chunks(256)
                .map(<[Value]>::to_vec)
                .enumerate()
                .collect::<Vec<_>>(),
        )
        .map(|(index, items)| async move {
            let result = self
                .post(
                    "checkbulk",
                    key,
                    &json!({"consistency": {"fullyConsistent": true}, "items": items}),
                    2 << 20,
                )
                .await?;
            Ok::<_, anyhow::Error>((index * 256, bulk_decisions(&items, &result)?))
        })
        .buffer_unordered(4)
        .try_collect()
        .await?;
        let mut allowed = vec![false; checks.len()];
        for (offset, decisions) in batches {
            allowed[offset..offset + decisions.len()].copy_from_slice(&decisions);
        }
        Ok(allowed)
    }
    async fn key(&self) -> anyhow::Result<String> {
        // Ofz's API key stays in the trusted backend. Reload it for rotation; never log it.
        let secret: Secret = Api::namespaced(self.kube.clone(), "ofz")
            .get("ofz-spicedb-key")
            .await
            .context("authorization credential unavailable")?;
        let key = secret
            .data
            .as_ref()
            .and_then(|d| d.get("preshared_key"))
            .context("authorization credential missing")?;
        let key = std::str::from_utf8(&key.0).context("invalid authorization credential")?;
        ensure!(
            !key.is_empty() && key.len() <= 8192 && !key.contains(['\r', '\n']),
            "invalid authorization credential"
        );
        Ok(key.to_owned())
    }
    async fn post(
        &self,
        operation: &str,
        key: &str,
        request: &Value,
        limit: usize,
    ) -> anyhow::Result<Value> {
        let mut response = self
            .http
            .post(format!("{}/v1/permissions/{operation}", self.endpoint))
            .bearer_auth(key)
            .json(request)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("authorization service unavailable"))?;
        ensure!(response.status().is_success(), "authorization check failed");
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("authorization response failed"))?
        {
            ensure!(
                bytes.len() + chunk.len() <= limit,
                "authorization response too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        let result: Value =
            serde_json::from_slice(&bytes).context("invalid authorization response")?;
        Ok(result)
    }
}
fn check_item(owner: &str, agent_uid: &str, connector: &str, tool: &str) -> Value {
    json!({"resource": {"objectType": "relay_tool", "objectId": tool_id(agent_uid, connector, tool)}, "permission": "execute", "subject": {"object": {"objectType": "relay_user", "objectId": owner}}})
}
fn decision(result: &Value) -> anyhow::Result<bool> {
    match result["permissionship"].as_str() {
        Some("PERMISSIONSHIP_HAS_PERMISSION") => Ok(true),
        Some("PERMISSIONSHIP_NO_PERMISSION" | "PERMISSIONSHIP_CONDITIONAL_PERMISSION") => Ok(false),
        _ => anyhow::bail!("invalid authorization decision"),
    }
}
fn bulk_decisions(items: &[Value], result: &Value) -> anyhow::Result<Vec<bool>> {
    let pairs = result["pairs"]
        .as_array()
        .context("invalid bulk authorization response")?;
    ensure!(
        pairs.len() == items.len(),
        "incomplete bulk authorization response"
    );
    items
        .iter()
        .zip(pairs)
        .map(|(expected, pair)| {
            let request = &pair["request"];
            ensure!(
                request["resource"] == expected["resource"]
                    && request["permission"] == expected["permission"]
                    && request["subject"]["object"] == expected["subject"]["object"],
                "mismatched authorization response"
            );
            ensure!(
                request["subject"]["optionalRelation"].is_null()
                    || request["subject"]["optionalRelation"] == "",
                "unexpected subject relation"
            );
            ensure!(
                request["context"].is_null() || request["context"] == json!({}),
                "unexpected authorization context"
            );
            ensure!(pair["error"].is_null(), "bulk authorization check failed");
            decision(&pair["item"])
        })
        .collect()
}

fn encoded(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub fn tool_id(agent_uid: &str, connector: &str, tool: &str) -> String {
    format!("{agent_uid}/{}/{}", encoded(connector), encoded(tool))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_ids_are_unambiguous_and_bound_to_creation_uid() {
        assert_ne!(tool_id("uid1", "a.b", "c"), tool_id("uid1", "a", "b.c"));
        assert_ne!(
            tool_id("uid1", "docs", "search"),
            tool_id("uid2", "docs", "search")
        );
        assert_eq!(
            tool_id("uid1", "docs", "search"),
            "uid1/646f6373/736561726368"
        );
    }
    #[test]
    fn bulk_response_correlation_and_failures_are_checked() {
        let items = vec![
            check_item("owner", "uid", "docs", "one"),
            check_item("owner", "uid", "docs", "two"),
        ];
        let response = json!({"pairs":[{"request":items[0],"item":{"permissionship":"PERMISSIONSHIP_HAS_PERMISSION"}},{"request":items[1],"item":{"permissionship":"PERMISSIONSHIP_CONDITIONAL_PERMISSION"}}]});
        assert_eq!(
            bulk_decisions(&items, &response).unwrap(),
            vec![true, false]
        );
        let mut reordered = response.clone();
        reordered["pairs"].as_array_mut().unwrap().reverse();
        assert!(bulk_decisions(&items, &reordered).is_err());
        let mut missing = response.clone();
        missing["pairs"].as_array_mut().unwrap().pop();
        assert!(bulk_decisions(&items, &missing).is_err());
        for replacement in [
            json!({"error":{"code":13}}),
            json!({"item":{"permissionship":"PERMISSIONSHIP_UNSPECIFIED"}}),
        ] {
            let mut bad = response.clone();
            for (key, value) in replacement.as_object().unwrap() {
                bad["pairs"][0][key] = value.clone();
            }
            assert!(bulk_decisions(&items, &bad).is_err());
        }
    }
    #[tokio::test]
    async fn maximum_catalog_uses_bounded_batches_and_one_credential_read() {
        use axum::{
            Json, Router,
            extract::State,
            routing::{get, post},
        };
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        #[derive(Clone, Default)]
        struct Counts {
            requests: Arc<AtomicUsize>,
            keys: Arc<AtomicUsize>,
            active: Arc<AtomicUsize>,
            max_active: Arc<AtomicUsize>,
        }
        async fn key(State(c): State<Counts>) -> Json<Value> {
            c.keys.fetch_add(1, Ordering::SeqCst);
            Json(
                json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"ofz-spicedb-key"},"data":{"preshared_key":"dGVzdC1rZXk="}}),
            )
        }
        async fn bulk(
            State(c): State<Counts>,
            headers: axum::http::HeaderMap,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            assert_eq!(headers["authorization"], "Bearer test-key");
            assert_eq!(body["consistency"], json!({"fullyConsistent":true}));
            let items = body["items"].as_array().unwrap();
            assert!(items.len() <= 256);
            c.requests.fetch_add(1, Ordering::SeqCst);
            let active = c.active.fetch_add(1, Ordering::SeqCst) + 1;
            c.max_active.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(5)).await;
            c.active.fetch_sub(1, Ordering::SeqCst);
            Json(
                json!({"pairs":items.iter().map(|item| json!({"request":item,"item":{"permissionship":"PERMISSIONSHIP_HAS_PERMISSION"}})).collect::<Vec<_>>()}),
            )
        }
        let counts = Counts::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = Router::new()
            .route("/api/v1/namespaces/ofz/secrets/ofz-spicedb-key", get(key))
            .route("/v1/permissions/checkbulk", post(bulk))
            .with_state(counts.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let client =
            Client::try_from(kube::Config::new(format!("http://{addr}").parse().unwrap())).unwrap();
        let authz = Authorizer::new(client, format!("http://{addr}")).unwrap();
        let checks = (0..8192)
            .map(|i| ("docs".into(), format!("tool-{i}")))
            .collect::<Vec<_>>();
        let allowed = authz.allowed_many("owner", "uid", &checks).await.unwrap();
        assert_eq!(allowed, vec![true; 8192]);
        assert_eq!(counts.requests.load(Ordering::SeqCst), 32);
        assert_eq!(counts.keys.load(Ordering::SeqCst), 1);
        assert!(counts.max_active.load(Ordering::SeqCst) > 1);
        assert!(counts.max_active.load(Ordering::SeqCst) <= 4);
        server.abort();
    }
}
