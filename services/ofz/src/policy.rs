use sha2::{Digest, Sha256};
use tonic::Status;
use uuid::Uuid;

use crate::proto::{Action, Actor, Resource, ResourceKind, actor::Identity};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Permission {
    pub resource_kind: ResourceKind,
    pub name: &'static str,
    pub diagnostic: bool,
}

impl Action {
    pub fn permission(self) -> Result<Permission, Status> {
        use Action::*;
        use ResourceKind::*;
        let (resource_kind, name, diagnostic) = match self {
            Action::Unspecified => {
                return Err(Status::invalid_argument("an explicit action is required"));
            }
            PlatformAdmit => (Platform, "admit", false),
            WorkspaceCreate => (Platform, "create_workspace", false),
            MembersManage => (Platform, "manage_members", false),
            QuotasManage => (Platform, "manage_quotas", false),
            TargetsManage => (Platform, "manage_targets", false),
            PolicyRead => (Platform, "read_policy", false),
            AuditRead => (Platform, "read_audit", false),
            PlatformOperate => (Platform, "operate", false),
            WorkspaceMetadataRead => (Workspace, "view_metadata", true),
            WorkspacePolicyRead => (Workspace, "read_access", false),
            WorkspaceResume => (Workspace, "resume", false),
            WorkspaceSleep => (Workspace, "sleep", false),
            WorkspacePowerConfigure => (Workspace, "configure_power", false),
            WorkspaceDelete => (Workspace, "delete", false),
            CollaboratorsManage => (Workspace, "manage_collaborators", false),
            GrantsManage => (Workspace, "manage_grants", false),
            WorkspaceTransfer => (Workspace, "transfer", false),
            FilesObserve => (Workspace, "observe_files", true),
            FilesWrite => (Workspace, "write_files", false),
            TerminalObserve => (Workspace, "observe_terminal", true),
            TerminalControl => (Workspace, "control_terminal", false),
            CodexObserve => (Workspace, "observe_codex", true),
            CodexControl => (Workspace, "control_codex", false),
            BrowserObserve => (Workspace, "observe_browser", true),
            BrowserControl => (Workspace, "control_browser", false),
            EditorOpen => (Workspace, "open_editor", false),
            PreviewObserve => (Workspace, "observe_preview", true),
            PreviewAccess => (Workspace, "access_preview", false),
            KubeStatusRead => (KubeNamespace, "read_status", true),
            KubeLogsRead => (KubeNamespace, "read_logs", true),
            KubeEventsRead => (KubeNamespace, "read_events", true),
            ConnectorRead => (ConnectorConnection, "read", true),
            SessionEstablish => (Platform, "establish_session", false),
            WorkspaceEnroll => (Platform, "enroll_workspace", false),
            KubeExecute => (Platform, "execute_kube", false),
            ConnectorExecute => (Platform, "execute_connector", false),
            PolicyCheck => (Platform, "check", false),
            PolicyCommand => (Platform, "command", false),
            SessionInspect => (Platform, "inspect_session", false),
        };
        Ok(Permission {
            resource_kind,
            name,
            diagnostic,
        })
    }
}

impl Resource {
    pub fn validate_for(&self, action: Action) -> Result<&'static str, Status> {
        let kind = ResourceKind::try_from(self.kind)
            .map_err(|_| Status::invalid_argument("unknown resource kind"))?;
        if kind != action.permission()?.resource_kind {
            return Err(Status::invalid_argument(
                "action does not apply to resource",
            ));
        }
        match kind {
            ResourceKind::Platform if self.id == "lab" => Ok("platform"),
            ResourceKind::Workspace if canonical_uuid(&self.id) => Ok("workspace"),
            ResourceKind::KubeNamespace => {
                let Some((cluster, uid)) = self.id.split_once('/') else {
                    return Err(Status::invalid_argument(
                        "namespace requires cluster and UID",
                    ));
                };
                if cluster != "galactic" || !canonical_uuid(uid) {
                    return Err(Status::invalid_argument("invalid namespace identity"));
                }
                Ok("kube_namespace")
            }
            ResourceKind::ConnectorConnection if canonical_uuid(&self.id) => {
                Ok("connector_connection")
            }
            _ => Err(Status::invalid_argument("invalid resource identity")),
        }
    }
}

impl Actor {
    pub fn subject(&self) -> Result<(&'static str, String), Status> {
        match self.identity.as_ref() {
            Some(Identity::HumanId(id)) if canonical_human_id(id) => Ok(("human", id.clone())),
            Some(Identity::AgentId(id)) if canonical_uuid(id) => Ok(("agent", id.clone())),
            Some(Identity::WorkloadId(id)) if allowed_workload(id) => {
                Ok(("workload", workload_object_id(id)))
            }
            _ => Err(Status::unauthenticated("invalid actor identity")),
        }
    }
}

pub fn requires_fresh_mfa(action: Action) -> bool {
    matches!(
        action,
        Action::MembersManage
            | Action::QuotasManage
            | Action::TargetsManage
            | Action::CollaboratorsManage
            | Action::GrantsManage
            | Action::WorkspaceTransfer
            | Action::WorkspaceDelete
            | Action::PlatformOperate
    )
}

pub fn requires_mfa(action: Action) -> bool {
    requires_fresh_mfa(action)
        || matches!(
            action,
            Action::FilesWrite
                | Action::TerminalControl
                | Action::CodexControl
                | Action::BrowserControl
                | Action::EditorOpen
                | Action::PreviewAccess
                | Action::WorkspaceResume
                | Action::WorkspaceSleep
                | Action::WorkspacePowerConfigure
        )
}

pub fn platform() -> Resource {
    Resource {
        kind: ResourceKind::Platform.into(),
        id: "lab".into(),
    }
}

pub fn workspace(uid: &str) -> Resource {
    Resource {
        kind: ResourceKind::Workspace.into(),
        id: uid.into(),
    }
}

pub fn workload_object_id(spiffe_id: &str) -> String {
    format!("{:x}", Sha256::digest(spiffe_id.as_bytes()))
}

pub fn canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}

pub fn canonical_human_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn github_human_id(numeric_id: &str) -> Result<String, Status> {
    if numeric_id.is_empty()
        || numeric_id.starts_with('0')
        || numeric_id.len() > 20
        || !numeric_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(Status::unauthenticated(
            "verified numeric GitHub ID required",
        ));
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("github:{numeric_id}"))
    ))
}

pub const BFF_ID: &str = "spiffe://proompteng.ai/ns/proompteng/sa/proompteng";
pub const CONTROLLER_ID: &str = "spiffe://proompteng.ai/ns/tengri/sa/tengri";
pub const OFZ_ID: &str = "spiffe://proompteng.ai/ns/ofz/sa/ofz-api";
pub const KUBE_BROKER_ID: &str = "spiffe://proompteng.ai/ns/tengri/sa/tengri-kube-broker";
pub const CONNECTOR_BROKER_ID: &str = "spiffe://proompteng.ai/ns/tengri/sa/tengri-connector-broker";

pub fn allowed_workload(value: &str) -> bool {
    matches!(
        value,
        BFF_ID | CONTROLLER_ID | OFZ_ID | KUBE_BROKER_ID | CONNECTOR_BROKER_ID
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_actions_and_reused_names_never_authorize() {
        assert!(Action::try_from(999).is_err());
        assert!(Action::Unspecified.permission().is_err());
        let resource = Resource {
            kind: ResourceKind::Workspace.into(),
            id: "tengri/agent-greg".into(),
        };
        assert!(
            resource
                .validate_for(Action::WorkspaceMetadataRead)
                .is_err()
        );
        assert!(resource.validate_for(Action::MembersManage).is_err());
        assert!(!canonical_uuid("00000000-0000-0000-0000-000000000000"));
    }

    #[test]
    fn diagnostic_actions_cannot_control_or_administrate() {
        for action in [
            Action::FilesWrite,
            Action::TerminalControl,
            Action::CodexControl,
            Action::BrowserControl,
            Action::EditorOpen,
            Action::PreviewAccess,
            Action::WorkspaceResume,
            Action::WorkspaceSleep,
            Action::MembersManage,
            Action::GrantsManage,
            Action::KubeExecute,
            Action::ConnectorExecute,
        ] {
            assert!(!action.permission().unwrap().diagnostic, "{action:?}");
        }
    }

    #[test]
    fn canonical_github_identity_matches_the_existing_contract() {
        assert_eq!(
            github_human_id("12027037").unwrap(),
            format!("{:x}", Sha256::digest(b"github:12027037"))
        );
        for value in ["gregkonush", "github:12027037", "012027037", "", "-1"] {
            assert!(github_human_id(value).is_err());
        }
        assert!(!allowed_workload(
            "spiffe://proompteng.ai/ns/tengri/sa/nanoagent"
        ));
    }
}
