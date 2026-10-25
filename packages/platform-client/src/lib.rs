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
