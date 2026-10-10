use std::{path::PathBuf, time::Duration};

use chrono::{DateTime, Utc};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tonic::Status;

use crate::{DECISION_TIMEOUT, policy::OFZ_ID, policy::workload_object_id};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Object {
    pub object_type: String,
    pub object_id: String,
}

impl Object {
    pub fn new(kind: &str, id: &str) -> Self {
        Self {
            object_type: kind.into(),
            object_id: id.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Subject {
    pub object: Object,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub resource: Object,
    pub relation: String,
    pub subject: Subject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optional_expires_at: Option<DateTime<Utc>>,
}

impl Relationship {
    pub fn new(kind: &str, id: &str, relation: &str, subject_kind: &str, subject_id: &str) -> Self {
        Self {
            resource: Object::new(kind, id),
            relation: relation.into(),
            subject: Subject {
                object: Object::new(subject_kind, subject_id),
            },
            optional_expires_at: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Update {
    pub operation: String,
    pub relationship: Relationship,
}

impl Update {
    pub fn touch(relationship: Relationship) -> Self {
        Self {
            operation: "OPERATION_TOUCH".into(),
            relationship,
        }
    }
    pub fn delete(relationship: Relationship) -> Self {
        Self {
            operation: "OPERATION_DELETE".into(),
            relationship,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Check {
    pub resource: Object,
    pub permission: String,
    pub subject: Subject,
}

impl Check {
    pub fn new(
        kind: &str,
        id: &str,
        permission: &str,
        subject_kind: &str,
        subject_id: &str,
    ) -> Self {
        Self {
            resource: Object::new(kind, id),
            permission: permission.into(),
            subject: Subject {
                object: Object::new(subject_kind, subject_id),
            },
        }
    }
}

#[derive(Clone)]
pub struct Native {
    client: reqwest::Client,
    endpoint: String,
    key_path: PathBuf,
    #[cfg(test)]
    check_barrier: Option<(
        std::sync::Arc<tokio::sync::Notify>,
        std::sync::Arc<tokio::sync::Notify>,
    )>,
}

impl Native {
    pub fn new(endpoint: &str, key_path: PathBuf) -> Result<Self, Status> {
        let url = reqwest::Url::parse(endpoint)
            .map_err(|_| Status::invalid_argument("invalid native endpoint"))?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || url.host_str().is_none()
        {
            return Err(Status::invalid_argument("invalid native endpoint"));
        }
        let client = reqwest::Client::builder()
            .timeout(DECISION_TIMEOUT)
            .connect_timeout(Duration::from_millis(500))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| Status::internal("native client configuration"))?;
        Ok(Self {
            client,
            endpoint: endpoint.trim_end_matches('/').into(),
            key_path,
            #[cfg(test)]
            check_barrier: None,
        })
    }

    #[cfg(test)]
    pub(crate) fn with_check_barrier(
        mut self,
        checked: std::sync::Arc<tokio::sync::Notify>,
        resume: std::sync::Arc<tokio::sync::Notify>,
    ) -> Self {
        self.check_barrier = Some((checked, resume));
        self
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, Status> {
        let key = tokio::fs::read_to_string(&self.key_path)
            .await
            .map_err(|_| Status::unavailable("native credential unavailable"))?;
        if key.trim().is_empty() {
            return Err(Status::unavailable("native credential unavailable"));
        }
        let response = self
            .client
            .post(format!("{}{path}", self.endpoint))
            .bearer_auth(key.trim())
            .json(&body)
            .send()
            .await
            .map_err(|_| Status::unavailable("authorization datastore unavailable"))?;
        let status = response.status();
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|_| Status::unavailable("authorization datastore response interrupted"))?;
            if bytes.len() + chunk.len() > 1_048_576 {
                return Err(Status::resource_exhausted(
                    "authorization datastore response limit",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Status::unavailable("invalid authorization datastore response"))?;
        if !status.is_success() {
            if status == reqwest::StatusCode::PRECONDITION_FAILED
                || value["code"].as_i64() == Some(9)
            {
                return Err(Status::aborted("policy version conflict"));
            }
            return Err(Status::unavailable(
                "authorization datastore rejected request",
            ));
        }
        Ok(value)
    }

    pub async fn check(&self, checks: &[Check]) -> Result<(bool, String), Status> {
        if checks.is_empty() || checks.len() > 64 {
            return Err(Status::invalid_argument("invalid permission check batch"));
        }
        let value = self
            .post(
                "/v1/permissions/checkbulk",
                json!({"consistency":{"fullyConsistent":true},"items":checks}),
            )
            .await?;
        let pairs = value["pairs"]
            .as_array()
            .filter(|pairs| pairs.len() == checks.len())
            .ok_or_else(|| Status::unavailable("incomplete authorization datastore decision"))?;
        let mut allowed = true;
        for (pair, expected) in pairs.iter().zip(checks) {
            let echoed: Check = serde_json::from_value(pair["request"].clone())
                .map_err(|_| Status::unavailable("invalid authorization decision binding"))?;
            if echoed != *expected {
                return Err(Status::unavailable(
                    "authorization decision binding mismatch",
                ));
            }
            match pair["item"]["permissionship"].as_str() {
                Some("PERMISSIONSHIP_HAS_PERMISSION") => {}
                Some("PERMISSIONSHIP_NO_PERMISSION") => allowed = false,
                _ => {
                    return Err(Status::unavailable(
                        "indeterminate authorization datastore decision",
                    ));
                }
            }
        }
        let revision = value["checkedAt"]["token"]
            .as_str()
            .filter(|r| !r.is_empty())
            .ok_or_else(|| Status::unavailable("missing authorization revision"))?;
        #[cfg(test)]
        if let Some((checked, resume)) = &self.check_barrier {
            checked.notify_one();
            resume.notified().await;
        }
        Ok((allowed, revision.into()))
    }

    pub async fn applied(&self, operation: &str) -> Result<(bool, String), Status> {
        self.check(&[Check::new(
            "applied_command",
            operation,
            "committed",
            "workload",
            &workload_object_id(OFZ_ID),
        )])
        .await
    }

    pub async fn apply(
        &self,
        operation: &str,
        expected_version: u64,
        changes: &[Update],
    ) -> Result<String, Status> {
        let mut updates = changes.to_vec();
        let marker = Relationship::new(
            "applied_command",
            operation,
            "committed",
            "workload",
            &workload_object_id(OFZ_ID),
        );
        let old = Relationship::new(
            "policy_version",
            "lab",
            "current",
            "workload",
            &format!("version_{expected_version}"),
        );
        if expected_version > 0 {
            updates.push(Update::delete(old));
        }
        updates.push(Update::touch(Relationship::new(
            "policy_version",
            "lab",
            "current",
            "workload",
            &format!("version_{}", expected_version + 1),
        )));
        updates.push(Update::touch(marker));
        let filter = if expected_version == 0 {
            json!({"resourceType":"policy_version","optionalResourceId":"lab","optionalRelation":"current"})
        } else {
            json!({"resourceType":"policy_version","optionalResourceId":"lab","optionalRelation":"current",
                "optionalSubjectFilter":{"subjectType":"workload","optionalSubjectId":format!("version_{expected_version}")}})
        };
        let value = self.post("/v1/relationships/write", json!({"updates":updates,"optionalPreconditions":[{
            "operation":if expected_version == 0 {"OPERATION_MUST_NOT_MATCH"} else {"OPERATION_MUST_MATCH"}, "filter":filter}]})).await?;
        value["writtenAt"]["token"]
            .as_str()
            .filter(|r| !r.is_empty())
            .map(String::from)
            .ok_or_else(|| Status::unavailable("missing policy write revision"))
    }
}
