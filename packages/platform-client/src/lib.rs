pub mod proompteng {
    pub mod authz {
        pub mod v1 {
            tonic::include_proto!("proompteng.authz.v1");
        }
    }
    pub mod relay {
        pub mod v1 {
            tonic::include_proto!("proompteng.relay.v1");
        }
    }
}
pub use proompteng::{authz::v1 as authz, relay::v1 as relay};
pub mod tls;
pub const MAX_EXECUTION_BODY_BYTES: usize = 65_536;
pub const MAX_RELAY_REQUEST_BYTES: usize = 262_144;
pub fn request<T>(value: T) -> tonic::Request<T> {
    let mut request = tonic::Request::new(value);
    request.metadata_mut().insert(
        "x-ofz-contract-version",
        tonic::metadata::MetadataValue::from_static("1"),
    );
    request.set_timeout(std::time::Duration::from_secs(30));
    request
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionPayload {
    pub operation_id: String,
    pub client_service: String,
    pub connector_id: String,
    pub operation: String,
    pub arguments: serde_json::Value,
    pub binding: Option<authz::PlatformBinding>,
    pub delegation_id: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionLookup {
    pub execution_body: String,
    pub binding: Option<authz::PlatformBinding>,
    pub delegation_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_preserves_exact_execution_bytes_and_cannot_decode_as_dispatch() {
        let original =
            "{\n  \"operationId\": \"original\", \"arguments\": {\"value\": \"\\u00e9\"}\n}";
        let body = serde_json::to_vec(&ExecutionLookup {
            execution_body: original.into(),
            binding: None,
            delegation_id: None,
        })
        .unwrap();
        let decoded: ExecutionLookup = serde_json::from_slice(&body).unwrap();
        assert_eq!(decoded.execution_body.as_bytes(), original.as_bytes());
        assert!(serde_json::from_slice::<ExecutionPayload>(&body).is_err());
        assert_ne!(body, original.as_bytes());
    }
}
