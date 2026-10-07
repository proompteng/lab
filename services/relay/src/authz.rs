use anyhow::{Context, ensure};
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
        self.allowed(
            &"0".repeat(64),
            "00000000-0000-0000-0000-000000000000",
            "health",
            "probe",
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
        let request = json!({
            "consistency": {"fullyConsistent": true},
            "resource": {"objectType": "relay_tool", "objectId": tool_id(agent_uid, connector, tool)},
            "permission": "execute",
            "subject": {"object": {"objectType": "relay_user", "objectId": owner}}
        });
        let mut response = self
            .http
            .post(format!("{}/v1/permissions/check", self.endpoint))
            .bearer_auth(key)
            .json(&request)
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
                bytes.len() + chunk.len() <= 65536,
                "authorization response too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        let result: Value =
            serde_json::from_slice(&bytes).context("invalid authorization response")?;
        match result["permissionship"].as_str() {
            Some("PERMISSIONSHIP_HAS_PERMISSION") => Ok(true),
            Some("PERMISSIONSHIP_NO_PERMISSION" | "PERMISSIONSHIP_CONDITIONAL_PERMISSION") => {
                Ok(false)
            }
            _ => anyhow::bail!("invalid authorization decision"),
        }
    }
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
}
