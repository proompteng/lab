pub mod catalog;
pub mod policy;

pub mod proto {
    tonic::include_proto!("proompteng.authz.v1");
}

pub const SCHEMA: &str = include_str!("../schema.zed");
pub const CONTRACT_VERSION: u32 = 1;
pub const DECISION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
pub const STREAM_RECHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
