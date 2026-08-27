use kube::CustomResource;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const CPU_MILLIS: u32 = 2_000;
pub const MEMORY_MIB: u32 = 4_096;
pub const WORKSPACE_GIB: u32 = 16;
pub const IDLE_MINUTES: i64 = 60;

#[derive(CustomResource, Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[kube(
    group = "runtime.proompteng.ai",
    version = "v1alpha1",
    kind = "MicroVM",
    plural = "microvms",
    singular = "microvm",
    shortname = "mvm",
    namespaced,
    status = "MicroVMStatus"
)]
#[serde(rename_all = "camelCase")]
pub struct MicroVMSpec {
    pub display_name: String,
    pub owner_hash: String,
    pub desired_state: MicroVMDesiredState,
    pub image: String,
    pub architecture: MicroVMArchitecture,
    pub resources: MicroVMResources,
    pub created_at: String,
    pub idle_deadline: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub enum MicroVMDesiredState {
    Running,
    Sleeping,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MicroVMArchitecture {
    #[default]
    Amd64,
    Arm64,
}

impl MicroVMArchitecture {
    pub fn kubernetes_label(self) -> &'static str {
        match self {
            Self::Amd64 => "amd64",
            Self::Arm64 => "arm64",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MicroVMResources {
    pub cpu_millis: u32,
    pub memory_mib: u32,
    pub workspace_gib: u32,
}

impl Default for MicroVMResources {
    fn default() -> Self {
        Self {
            cpu_millis: CPU_MILLIS,
            memory_mib: MEMORY_MIB,
            workspace_gib: WORKSPACE_GIB,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MicroVMStatus {
    pub phase: MicroVMPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pod_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pvc_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pod_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_name: Option<String>,
    #[serde(default)]
    pub guest_ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ready_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(default)]
    pub conditions: Vec<MicroVMCondition>,
    #[serde(default)]
    pub observed_generation: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MicroVMCondition {
    #[serde(rename = "type")]
    pub type_: String,
    pub status: String,
    pub reason: String,
    pub message: String,
    pub last_transition_at: String,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub enum MicroVMPhase {
    #[default]
    Pending,
    Booting,
    Ready,
    Sleeping,
    Failed,
    Terminating,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_resource_profile_is_fixed() {
        assert_eq!(MicroVMResources::default().cpu_millis, 2_000);
        assert_eq!(MicroVMResources::default().memory_mib, 4_096);
        assert_eq!(MicroVMResources::default().workspace_gib, 16);
    }
}
