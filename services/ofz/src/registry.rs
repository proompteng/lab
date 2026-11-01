use std::{collections::BTreeSet, sync::OnceLock};

use serde::{Deserialize, Serialize};
use tonic::Status;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceRegistration {
    pub id: String,
    pub identities: Vec<String>,
    pub roles: Vec<String>,
    #[serde(default)]
    pub session_gateway: Option<SessionGateway>,
    #[serde(default)]
    pub proof_audience: Option<String>,
    #[serde(default)]
    pub binding: Option<BindingPolicy>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionGateway {
    pub oidc_client_id: String,
    pub origin: String,
}

impl ServiceRegistration {
    pub fn allows_origin(&self, origin: &str) -> bool {
        self.session_gateway
            .as_ref()
            .is_some_and(|gateway| gateway.origin == origin)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingPolicy {
    pub service: String,
    pub resource_kind: String,
    pub action: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub version: u32,
    pub services: Vec<ServiceRegistration>,
}

pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_.".contains(&byte)
        })
}

impl Registry {
    pub fn parse(bytes: &[u8]) -> Result<Self, Status> {
        if bytes.len() > 256 * 1024 {
            return Err(Status::invalid_argument(
                "service registry exceeds its byte budget",
            ));
        }
        let registry: Self = serde_json::from_slice(bytes)
            .map_err(|_| Status::invalid_argument("invalid service registry"))?;
        if registry.version != 1 || registry.services.is_empty() || registry.services.len() > 128 {
            return Err(Status::invalid_argument(
                "invalid service registry version or size",
            ));
        }
        let mut ids = BTreeSet::new();
        let mut identities = BTreeSet::new();
        let mut gateway_origins = BTreeSet::new();
        let mut gateway_audiences = BTreeSet::new();
        for service in &registry.services {
            if !identifier(&service.id)
                || !ids.insert(&service.id)
                || service.identities.is_empty()
                || service.identities.len() > 16
                || service.roles.is_empty()
                || service.roles.len() > 32
            {
                return Err(Status::invalid_argument(
                    "invalid or duplicate service registration",
                ));
            }
            let mut roles = BTreeSet::new();
            for role in &service.roles {
                if !identifier(role) || !roles.insert(role) {
                    return Err(Status::invalid_argument(
                        "invalid or duplicate service role",
                    ));
                }
            }
            if let Some(gateway) = &service.session_gateway {
                if gateway.oidc_client_id.is_empty()
                    || gateway.oidc_client_id.len() > 256
                    || gateway
                        .oidc_client_id
                        .chars()
                        .any(|c| c.is_control() || c.is_whitespace())
                    || !gateway_audiences.insert(&gateway.oidc_client_id)
                {
                    return Err(Status::invalid_argument(
                        "OIDC audience required for a session gateway",
                    ));
                }
                let origin = &gateway.origin;
                let url = reqwest::Url::parse(origin)
                    .map_err(|_| Status::invalid_argument("invalid registered client origin"))?;
                if url.scheme() != "https"
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.origin().ascii_serialization() != *origin
                    || !gateway_origins.insert(origin)
                {
                    return Err(Status::invalid_argument("invalid registered client origin"));
                }
            }
            if let Some(audience) = &service.proof_audience {
                let url = reqwest::Url::parse(audience)
                    .map_err(|_| Status::invalid_argument("invalid registered proof audience"))?;
                if url.scheme() != "https"
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || url.path() == "/"
                    || !service.allows_origin(&url.origin().ascii_serialization())
                {
                    return Err(Status::invalid_argument(
                        "proof audience must belong to a registered client origin",
                    ));
                }
            }
            if service.binding.as_ref().is_some_and(|b| {
                !identifier(&b.service) || !identifier(&b.resource_kind) || !identifier(&b.action)
            }) {
                return Err(Status::invalid_argument(
                    "invalid client execution binding policy",
                ));
            }
            for identity in &service.identities {
                let parsed: spiffe::SpiffeId = identity
                    .parse()
                    .map_err(|_| Status::invalid_argument("invalid registered SPIFFE identity"))?;
                if !identity.starts_with("spiffe://proompteng.ai/ns/")
                    || identity.contains(['*', '?', '#', '%'])
                    || parsed.to_string() != *identity
                    || !identities.insert(identity)
                {
                    return Err(Status::invalid_argument(
                        "untrusted or duplicate service identity",
                    ));
                }
            }
        }
        Ok(registry)
    }

    pub fn service(&self, identity: &str) -> Option<&ServiceRegistration> {
        self.services.iter().find(|service| {
            service
                .identities
                .iter()
                .any(|candidate| candidate == identity)
        })
    }

    pub fn has_role(&self, identity: &str, role: &str) -> bool {
        self.service(identity)
            .is_some_and(|service| service.roles.iter().any(|candidate| candidate == role))
    }

    pub fn by_id(&self, id: &str) -> Option<&ServiceRegistration> {
        self.services.iter().find(|service| service.id == id)
    }

    pub fn session_gateway(&self, peer: &str) -> Result<(&str, &SessionGateway), Status> {
        let service = self
            .service(peer)
            .ok_or_else(|| Status::permission_denied("registered session gateway required"))?;
        let gateway = service
            .session_gateway
            .as_ref()
            .ok_or_else(|| Status::permission_denied("registered session gateway required"))?;
        Ok((&service.id, gateway))
    }

    pub fn identities(&self) -> impl Iterator<Item = &str> {
        self.services
            .iter()
            .flat_map(|service| service.identities.iter().map(String::as_str))
    }
}

pub fn configured() -> Result<&'static Registry, Status> {
    static REGISTRY: OnceLock<Result<Registry, String>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| {
            let bytes = match std::env::var("OFZ_SERVICES_FILE") {
                Ok(path) => {
                    std::fs::read(path).map_err(|_| "service registry is unavailable".to_owned())?
                }
                Err(std::env::VarError::NotPresent) => {
                    include_bytes!("../platform/services.json").to_vec()
                }
                Err(_) => return Err("invalid service registry path".into()),
            };
            Registry::parse(&bytes).map_err(|error| error.message().to_owned())
        })
        .as_ref()
        .map_err(|message| Status::failed_precondition(message.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_new_service_enrolls_without_changing_the_identity_evaluator() {
        let registry = Registry::parse(
            &serde_json::to_vec(&json!({"version":1,"services":[{
                "id":"example", "identities":["spiffe://proompteng.ai/ns/example/sa/api"],
                "roles":["example.reader"]
            }]}))
            .unwrap(),
        )
        .unwrap();
        assert!(registry.has_role("spiffe://proompteng.ai/ns/example/sa/api", "example.reader"));
        assert!(!registry.has_role(
            "spiffe://proompteng.ai/ns/example/sa/api",
            "platform.administration"
        ));
        assert!(
            registry
                .service("spiffe://proompteng.ai/ns/example/sa/other")
                .is_none()
        );
    }

    #[test]
    fn independent_browser_gateways_enroll_without_application_branches() {
        let input = json!({"version":1,"services":[
            {"id":"product", "identities":["spiffe://proompteng.ai/ns/product/sa/web"],
             "roles":["platform.client"], "session_gateway":{"oidc_client_id":"product", "origin":"https://product.example"}},
            {"id":"admin", "identities":["spiffe://proompteng.ai/ns/admin/sa/web"],
             "roles":["platform.administration"], "session_gateway":{"oidc_client_id":"admin", "origin":"https://admin.example"}}
        ]});
        assert!(Registry::parse(&serde_json::to_vec(&input).unwrap()).is_ok());
        for invalid in [
            json!({"oidc_client_id":"", "origin":"https://admin.example"}),
            json!({"oidc_client_id":"admin", "origin":""}),
            json!({"oidc_client_id":"admin", "origin":"http://admin.example"}),
            json!({"oidc_client_id":"admin", "origin":"https://product.example"}),
            json!({"oidc_client_id":"product", "origin":"https://admin.example"}),
        ] {
            let mut rejected = input.clone();
            rejected["services"][1]["session_gateway"] = invalid;
            assert!(Registry::parse(&serde_json::to_vec(&rejected).unwrap()).is_err());
        }
    }

    #[test]
    fn enrollment_rejects_duplicate_and_untrusted_identities() {
        for identity in [
            "spiffe://other.example/ns/app/sa/api",
            "spiffe://proompteng.ai/ns/*/sa/api",
        ] {
            let input = json!({"version":1,"services":[{"id":"app","identities":[identity],"roles":["app.reader"]}]});
            assert!(Registry::parse(&serde_json::to_vec(&input).unwrap()).is_err());
        }
        let mut input: serde_json::Value =
            serde_json::from_slice(include_bytes!("../platform/services.json")).unwrap();
        let duplicate = input["services"][0].clone();
        input["services"].as_array_mut().unwrap().push(duplicate);
        assert!(Registry::parse(&serde_json::to_vec(&input).unwrap()).is_err());
    }

    #[test]
    fn the_reviewed_registry_keeps_research_unenrolled() {
        let registry = Registry::parse(include_bytes!("../platform/services.json")).unwrap();
        assert!(registry.has_role(
            "spiffe://proompteng.ai/ns/opencode/sa/opencode",
            "relay.client"
        ));
        assert!(
            registry
                .service("spiffe://proompteng.ai/ns/opencode/sa/opencode-research")
                .is_none()
        );
    }
}
