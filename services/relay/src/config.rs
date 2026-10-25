use serde::Deserialize;
use std::{collections::BTreeSet, path::Path};
use tonic::Status;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Namespace {
    pub name: String,
    pub uid: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Connector {
    Kubernetes {
        id: String,
        endpoint: String,
        ca_file: String,
        token_file: String,
        namespaces: Vec<Namespace>,
    },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub connectors: Vec<Connector>,
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
}
impl Config {
    pub fn parse(bytes: &[u8]) -> Result<Self, Status> {
        if bytes.len() > 262_144 {
            return Err(Status::invalid_argument(
                "Relay configuration exceeds its byte budget",
            ));
        }
        let config: Self = serde_json::from_slice(bytes)
            .map_err(|_| Status::invalid_argument("invalid Relay configuration"))?;
        if config.version != 1 || config.connectors.is_empty() || config.connectors.len() > 32 {
            return Err(Status::invalid_argument(
                "invalid Relay configuration version or size",
            ));
        }
        let mut connectors = BTreeSet::new();
        for connector in &config.connectors {
            match connector {
                Connector::Kubernetes {
                    id,
                    endpoint,
                    ca_file,
                    token_file,
                    namespaces,
                } => {
                    let url = reqwest::Url::parse(endpoint)
                        .map_err(|_| Status::invalid_argument("invalid cluster endpoint"))?;
                    if !identifier(id)
                        || id.contains('.')
                        || !connectors.insert(id)
                        || url.scheme() != "https"
                        || url.host_str().is_none()
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.path() != "/"
                        || url.query().is_some()
                        || url.fragment().is_some()
                        || !Path::new(ca_file).is_absolute()
                        || !Path::new(token_file).is_absolute()
                        || namespaces.is_empty()
                        || namespaces.len() > 128
                    {
                        return Err(Status::invalid_argument(
                            "invalid Kubernetes connector registration",
                        ));
                    }
                    let mut names = BTreeSet::new();
                    let mut uids = BTreeSet::new();
                    for namespace in namespaces {
                        if !crate::kubernetes::name(&namespace.name)
                            || uuid::Uuid::parse_str(&namespace.uid).is_err()
                            || !names.insert(&namespace.name)
                            || !uids.insert(&namespace.uid)
                        {
                            return Err(Status::invalid_argument("invalid namespace registration"));
                        }
                    }
                }
            }
        }
        Ok(config)
    }
}
