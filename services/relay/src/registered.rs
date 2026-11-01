use crate::connector::{Normalized, allows_operation};
use platform_client::{
    authz::{PlatformConnectionScope, PlatformResource},
    relay::{ConnectorOperation, ConnectorTarget},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tonic::Status;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub name: String,
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub name: String,
    pub description: String,
    pub action: String,
    pub target: Target,
    pub input_schema: Value,
}

pub struct RegisteredOperation {
    definition: Operation,
    validator: jsonschema::Validator,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Prepared {
    pub operation: String,
    pub arguments: Value,
}

impl RegisteredOperation {
    pub fn new(definition: Operation) -> anyhow::Result<Self> {
        anyhow::ensure!(
            crate::config::identifier(&definition.name)
                && crate::config::identifier(&definition.action)
                && crate::config::identifier(&definition.target.kind)
                && !definition.description.trim().is_empty()
                && definition.description.len() <= 1024
                && !definition.target.name.trim().is_empty()
                && definition.target.name.len() <= 128
                && !definition.target.id.is_empty()
                && definition.target.id.len() <= 256
                && definition
                    .target
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/_|-=+".contains(&b))
                && definition.input_schema.get("type").and_then(Value::as_str) == Some("object")
                && definition.input_schema.get("additionalProperties") == Some(&Value::Bool(false))
                && serde_json::to_vec(&definition.input_schema)?.len() <= 16_384,
            "invalid registered operation"
        );
        // No network or filesystem retrievers are compiled in. Schemas are reviewed configuration.
        let validator = jsonschema::validator_for(&definition.input_schema)
            .map_err(|_| anyhow::anyhow!("invalid operation input schema"))?;
        Ok(Self {
            definition,
            validator,
        })
    }

    pub fn name(&self) -> &str {
        &self.definition.name
    }

    fn resource(&self) -> PlatformResource {
        PlatformResource {
            kind: self.definition.target.kind.clone(),
            id: self.definition.target.id.clone(),
            target: String::new(),
        }
    }

    pub fn discovery(
        &self,
        connector: &str,
        access: Option<&[PlatformConnectionScope]>,
    ) -> Option<ConnectorOperation> {
        let resource = self.resource();
        allows_operation(access, &self.definition.action, &resource).then(|| ConnectorOperation {
            connector_id: connector.into(),
            name: self.definition.name.clone(),
            description: self.definition.description.clone(),
            action: self.definition.action.clone(),
            input_schema_json: serde_json::to_vec(&self.definition.input_schema)
                .expect("registered JSON schema"),
            targets: vec![ConnectorTarget {
                name: self.definition.target.name.clone(),
                resource: Some(resource),
            }],
            read_only: true,
        })
    }

    pub fn normalize(&self, arguments: &[u8]) -> Result<Normalized, Status> {
        if arguments.len() > 16_384 {
            return Err(Status::invalid_argument(
                "connector arguments exceed their byte budget",
            ));
        }
        let arguments: Value = serde_json::from_slice(arguments)
            .map_err(|_| Status::invalid_argument("invalid connector arguments"))?;
        if !self.validator.is_valid(&arguments) {
            return Err(Status::invalid_argument(
                "arguments do not match the registered input schema",
            ));
        }
        Ok(Normalized {
            action: self.definition.action.clone(),
            resources: vec![self.resource()],
            prepared_request: serde_json::to_vec(&Prepared {
                operation: self.definition.name.clone(),
                arguments,
            })
            .map_err(|_| Status::internal("encode normalized connector request"))?,
        })
    }
}
