use anyhow::ensure;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::IpAddr;
use url::Url;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub connectors: Vec<Connector>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connector {
    pub id: String,
    pub owner_hash: String,
    pub agent_id: String,
    pub endpoint: String,
    pub credential_key: Option<String>,
    pub tools: Vec<Tool>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub read_only: bool,
}
impl Tool {
    pub fn validator(&self) -> anyhow::Result<jsonschema::Validator> {
        jsonschema::options()
            .offline()
            .should_validate_formats(true)
            .should_ignore_unknown_formats(false)
            .build(&self.input_schema)
            .map_err(|_| anyhow::anyhow!("invalid tool schema"))
    }
}
impl Catalog {
    pub fn validate(&self) -> anyhow::Result<()> {
        ensure!(self.connectors.len() <= 128, "too many connectors");
        let mut ids = std::collections::HashSet::new();
        for g in &self.connectors {
            ensure!(
                identifier(&g.id) && !g.id.contains("__") && ids.insert((&g.agent_id, &g.id)),
                "invalid or duplicate connector"
            );
            ensure!(
                g.owner_hash.len() == 64
                    && g.owner_hash
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
                "invalid owner hash"
            );
            ensure!(
                g.agent_id.starts_with("agent-") && identifier(&g.agent_id),
                "invalid agent"
            );
            endpoint(&g.endpoint)?;
            if let Some(key) = &g.credential_key {
                ensure!(identifier(key), "invalid credential key");
            }
            ensure!(
                !g.tools.is_empty() && g.tools.len() <= 64,
                "invalid tool count"
            );
            let mut names = std::collections::HashSet::new();
            for t in &g.tools {
                ensure!(
                    identifier(&t.name)
                        && names.insert(&t.name)
                        && t.read_only
                        && t.input_schema["type"] == "object"
                        && t.description.len() <= 4096,
                    "only explicit read-only tools with object schemas are supported"
                );
                t.validator()?;
            }
        }
        Ok(())
    }
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}
pub fn guest_uid<'a>(peer: &'a str, domain: &str) -> anyhow::Result<&'a str> {
    let prefix = format!("spiffe://{domain}/ns/tengri/nanoagent/pod/");
    let uid = peer
        .strip_prefix(&prefix)
        .ok_or_else(|| anyhow::anyhow!("unauthorized SPIFFE identity"))?;
    ensure!(
        uid.len() == 36
            && uid
                .bytes()
                .enumerate()
                .all(|(i, b)| if [8, 13, 18, 23].contains(&i) {
                    b == b'-'
                } else {
                    b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
                }),
        "invalid guest UID"
    );
    Ok(uid)
}
pub fn endpoint(raw: &str) -> anyhow::Result<Url> {
    let url = Url::parse(raw)?;
    ensure!(
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && url.port_or_known_default() == Some(443),
        "HTTPS port 443 only, without userinfo or fragments"
    );
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("missing hostname"))?;
    ensure!(
        host.contains('.')
            && host.parse::<IpAddr>().is_err()
            && !host.ends_with('.')
            && ![".local", ".localhost", ".internal", ".cluster.local"]
                .iter()
                .any(|s| host.ends_with(s)),
        "public DNS hostname required"
    );
    Ok(url)
}
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0)
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113))
        }
        // IPv6 is deliberately unsupported until its special-use ranges have matching network policy coverage.
        IpAddr::V6(_) => false,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identities_are_exact() {
        let uid = "00112233-4455-6677-8899-aabbccddeeff";
        assert_eq!(
            guest_uid(
                &format!("spiffe://proompteng.ai/ns/tengri/nanoagent/pod/{uid}"),
                "proompteng.ai"
            )
            .unwrap(),
            uid
        );
        for p in [
            format!("spiffe://evil.ai/ns/tengri/nanoagent/pod/{uid}"),
            "spiffe://proompteng.ai/ns/tengri/sa/tengri".into(),
            format!("spiffe://proompteng.ai/ns/tengri/nanoagent/pod/{uid}/x"),
        ] {
            assert!(guest_uid(&p, "proompteng.ai").is_err());
        }
    }
    #[test]
    fn rejects_ssrf_targets() {
        for u in [
            "http://example.com/mcp",
            "https://127.0.0.1/mcp",
            "https://[::1]/mcp",
            "https://metadata.google.internal/mcp",
            "https://relay.relay.svc.cluster.local/mcp",
            "https://token@example.com/mcp",
            "https://example.com:8443/mcp",
            "https://example.com/mcp#fragment",
        ] {
            assert!(endpoint(u).is_err(), "{u}");
        }
        assert!(endpoint("https://developers.openai.com/mcp").is_ok());
        for ip in [
            "10.1.2.3",
            "100.100.244.141",
            "169.254.169.254",
            "127.0.0.1",
            "172.16.1.2",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "2001:4860:4860::8888",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
    }
    #[test]
    fn configuration_fails_closed() {
        let empty: Catalog = serde_json::from_value(serde_json::json!({"connectors":[]})).unwrap();
        assert!(empty.validate().is_ok());
        let mut grants: Catalog=serde_json::from_value(serde_json::json!({"connectors":[{"id":"docs","ownerHash":"a".repeat(64),"agentId":"agent-test","endpoint":"https://example.com/mcp","credentialKey":null,"tools":[{"name":"search","description":"Search","inputSchema":{"type":"object"},"readOnly":false}]}]})).unwrap();
        assert!(grants.validate().is_err());
        grants.connectors[0].tools[0].read_only = true;
        assert!(grants.validate().is_ok());
        grants.connectors.push(grants.connectors[0].clone());
        assert!(grants.validate().is_err());
    }
    #[test]
    fn schema_enforces_constraints_without_external_retrieval() {
        let mut tool = Tool {
            name: "search".into(),
            description: "Search".into(),
            read_only: true,
            input_schema: serde_json::json!({"type":"object","required":["query"],"properties":{"query":{"type":"string","minLength":3,"maxLength":20},"scope":{"enum":["docs"]}},"additionalProperties":false}),
        };
        let validator = tool.validator().unwrap();
        assert!(validator.is_valid(&serde_json::json!({"query":"relay","scope":"docs"})));
        for args in [
            serde_json::json!({}),
            serde_json::json!({"query":"ab"}),
            serde_json::json!({"query":42}),
            serde_json::json!({"query":"relay","scope":"admin"}),
            serde_json::json!({"query":"relay","target":"https://other.example"}),
        ] {
            assert!(!validator.is_valid(&args));
        }
        tool.input_schema =
            serde_json::json!({"type":"object","$ref":"https://example.com/schema.json"});
        assert!(tool.validator().is_err());
        tool.input_schema = serde_json::json!({"type":"object","$ref":"file:///var/run/secrets/relay-credentials/token"});
        assert!(tool.validator().is_err());
        tool.input_schema = serde_json::json!({"type":"object","format":"unknown-security-format"});
        assert!(tool.validator().is_err());
    }
}
