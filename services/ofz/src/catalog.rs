use std::sync::OnceLock;

use serde::Deserialize;
use tonic::Status;

use crate::proto::Action;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub surface: String,
    pub operation: String,
    pub action: Option<String>,
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub internal_only: bool,
    pub dispatch: Option<String>,
}

pub fn operations() -> &'static [Operation] {
    static OPERATIONS: OnceLock<Vec<Operation>> = OnceLock::new();
    OPERATIONS.get_or_init(|| {
        serde_json::from_str(include_str!("../operations.json"))
            .expect("compiled operation catalog must be valid")
    })
}

pub fn operation_action(surface: &str, operation: &str) -> Result<Option<Action>, Status> {
    let entry = operations()
        .iter()
        .find(|entry| entry.surface == surface && entry.operation == operation)
        .ok_or_else(|| Status::permission_denied("unclassified operation"))?;
    if entry.public && entry.action.is_none() {
        return Ok(None);
    }
    let action = entry
        .action
        .as_deref()
        .and_then(Action::from_str_name)
        .ok_or_else(|| Status::permission_denied("invalid operation action"))?;
    action.permission()?;
    Ok(Some(action))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_operations_have_an_explicit_valid_policy() {
        let mut keys = std::collections::HashSet::new();
        for entry in operations() {
            assert!(keys.insert((&entry.surface, &entry.operation)));
            let action = operation_action(&entry.surface, &entry.operation).unwrap();
            assert_eq!(action.is_none(), entry.public);
        }
        assert!(operation_action("controller", "UnknownRpc").is_err());
        assert!(operation_action("guest", "Exec").is_err());
        assert!(operation_action("codex", "thread/fork").is_err());
    }

    #[test]
    fn audit_reads_require_the_auditor_permission() {
        assert_eq!(
            operation_action("ofz", "ReadAudit").unwrap(),
            Some(Action::AuditRead)
        );
    }

    #[test]
    fn interactive_gets_and_restore_are_privileged() {
        for (surface, operation) in [
            ("gateway", "* {*preview_host_proxy}"),
            ("gateway", "GET /_tengri/editor/open"),
            ("gateway", "HEAD /_tengri/editor/open"),
            ("controller", "ResumeCodexThread"),
            ("controller", "GetCodexAccount"),
            ("codex", "account/read"),
            ("codex", "thread/resume"),
        ] {
            assert!(
                !operation_action(surface, operation)
                    .unwrap()
                    .unwrap()
                    .permission()
                    .unwrap()
                    .diagnostic
            );
        }
    }
}
