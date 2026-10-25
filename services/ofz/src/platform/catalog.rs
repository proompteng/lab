use std::{collections::BTreeSet, sync::OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tonic::Status;

use crate::registry::identifier;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Relation {
    pub name: String,
    pub subjects: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceDefinition {
    pub kind: String,
    pub native_type: String,
    pub relations: Vec<Relation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionDefinition {
    pub id: String,
    pub resource_kind: String,
    pub permission: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyCatalog {
    pub version: u32,
    pub resources: Vec<ResourceDefinition>,
    pub actions: Vec<ActionDefinition>,
}

impl PolicyCatalog {
    pub fn parse(bytes: &[u8]) -> Result<Self, Status> {
        if bytes.len() > 1024 * 1024 {
            return Err(Status::invalid_argument(
                "policy catalog exceeds its byte budget",
            ));
        }
        let catalog: Self = serde_json::from_slice(bytes)
            .map_err(|_| Status::invalid_argument("invalid policy catalog"))?;
        if catalog.version != 1 || catalog.resources.len() > 256 || catalog.actions.len() > 1024 {
            return Err(Status::invalid_argument(
                "invalid policy catalog version or size",
            ));
        }
        let mut resources = BTreeSet::new();
        let mut native_types = BTreeSet::new();
        for resource in &catalog.resources {
            if !identifier(&resource.kind)
                || !resource.kind.contains('.')
                || !native_identifier(&resource.native_type)
                || !resources.insert(resource.kind.as_str())
                || !native_types.insert(resource.native_type.as_str())
                || resource.relations.len() > 128
            {
                return Err(Status::invalid_argument(
                    "invalid or duplicate policy resource",
                ));
            }
            let mut relations = BTreeSet::new();
            for relation in &resource.relations {
                let subjects: BTreeSet<_> = relation.subjects.iter().map(String::as_str).collect();
                if !native_identifier(&relation.name)
                    || !relations.insert(relation.name.as_str())
                    || subjects.is_empty()
                    || subjects.len() != relation.subjects.len()
                    || subjects
                        .iter()
                        .any(|kind| !matches!(*kind, "human" | "workload"))
                {
                    return Err(Status::invalid_argument("invalid policy relation"));
                }
            }
        }
        let mut actions = BTreeSet::new();
        for action in &catalog.actions {
            if !identifier(&action.id)
                || !action.id.contains('.')
                || !actions.insert(action.id.as_str())
                || !resources.contains(action.resource_kind.as_str())
                || !native_identifier(&action.permission)
            {
                return Err(Status::invalid_argument(
                    "invalid or duplicate policy action",
                ));
            }
        }
        Ok(catalog)
    }

    pub fn resource(&self, kind: &str) -> Result<&ResourceDefinition, Status> {
        self.resources
            .iter()
            .find(|resource| resource.kind == kind)
            .ok_or_else(|| Status::permission_denied("unregistered resource kind"))
    }

    pub fn action(&self, id: &str) -> Result<&ActionDefinition, Status> {
        self.actions
            .iter()
            .find(|action| action.id == id)
            .ok_or_else(|| Status::permission_denied("unregistered action"))
    }

    pub fn checksum(&self) -> Result<Vec<u8>, Status> {
        let bytes =
            serde_json::to_vec(self).map_err(|_| Status::internal("encode policy catalog"))?;
        Ok(Sha256::digest(bytes).to_vec())
    }
}

fn native_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

pub fn configured() -> Result<&'static PolicyCatalog, Status> {
    static CATALOG: OnceLock<Result<PolicyCatalog, String>> = OnceLock::new();
    CATALOG
        .get_or_init(|| {
            let bytes = match std::env::var("OFZ_POLICY_CATALOG_FILE") {
                Ok(path) => {
                    std::fs::read(path).map_err(|_| "policy catalog is unavailable".to_owned())?
                }
                Err(std::env::VarError::NotPresent) => {
                    include_bytes!("../../platform/policies.json").to_vec()
                }
                Err(_) => return Err("invalid policy catalog path".into()),
            };
            PolicyCatalog::parse(&bytes).map_err(|error| error.message().to_owned())
        })
        .as_ref()
        .map_err(|message| Status::failed_precondition(message.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn new_domain_policies_do_not_require_an_action_enum_change() {
        let catalog = PolicyCatalog::parse(&serde_json::to_vec(&json!({
            "version":1,"resources":[{"kind":"example.document","nativeType":"example_document","relations":[{"name":"reader","subjects":["human","workload"]}]}],
            "actions":[{"id":"example.document.read","resourceKind":"example.document","permission":"read"}]
        })).unwrap()).unwrap();
        let action = catalog.action("example.document.read").unwrap();
        assert_eq!(
            catalog.resource(&action.resource_kind).unwrap().native_type,
            "example_document"
        );
        assert!(catalog.action("example.document.write").is_err());
        assert!(catalog.resource("other.document").is_err());
    }

    #[test]
    fn invalid_catalogs_cannot_widen_existing_policy() {
        let original: serde_json::Value =
            serde_json::from_slice(include_bytes!("../../platform/policies.json")).unwrap();
        let mut unknown = original.clone();
        unknown["actions"][0]["resourceKind"] = json!("unknown.resource");
        assert!(PolicyCatalog::parse(&serde_json::to_vec(&unknown).unwrap()).is_err());
        let mut duplicate = original.clone();
        let action = duplicate["actions"][0].clone();
        duplicate["actions"].as_array_mut().unwrap().push(action);
        assert!(PolicyCatalog::parse(&serde_json::to_vec(&duplicate).unwrap()).is_err());
        let mut wildcard = original;
        wildcard["resources"][0]["relations"][0]["subjects"] = json!(["*"]);
        assert!(PolicyCatalog::parse(&serde_json::to_vec(&wildcard).unwrap()).is_err());
    }
}
