use crate::{
    config::Namespace,
    connector::{Connector, Failure, Normalized, Output, allows_operation},
};
use futures::StreamExt;
use platform_client::{
    authz::{PlatformConnectionScope, PlatformResource},
    relay::{ConnectorOperation, ConnectorTarget},
};
use serde::{Deserialize, Serialize};
use tonic::Status;

pub struct Kubernetes {
    id: String,
    endpoint: reqwest::Url,
    token_file: String,
    namespaces: Vec<Namespace>,
    client: reqwest::Client,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    namespace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pod: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    container: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tail_lines: Option<u32>,
}
#[derive(Debug, Deserialize, Serialize)]
struct PreparedRequest {
    operation: String,
    arguments: Arguments,
    path: String,
    query: Vec<(String, String)>,
}
pub fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-.".contains(&b))
}
impl Kubernetes {
    pub fn new(
        id: String,
        endpoint: String,
        ca_file: &str,
        token_file: String,
        namespaces: Vec<Namespace>,
    ) -> anyhow::Result<Self> {
        let ca = std::fs::read(ca_file)?;
        anyhow::ensure!(ca.len() <= 131_072, "cluster CA exceeds its byte budget");
        let client = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .tls_certs_only([reqwest::Certificate::from_pem(&ca)?])
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(10))
            .build()?;
        Ok(Self {
            id,
            endpoint: reqwest::Url::parse(&endpoint)?,
            token_file,
            namespaces,
            client,
        })
    }
    async fn read(
        &self,
        path: &str,
        query: &[(String, String)],
        token: &str,
        limit: usize,
    ) -> Result<(Vec<u8>, u32), Failure> {
        let url = self.endpoint.join(path).map_err(|_| Failure {
            status: Status::internal("invalid normalized Kubernetes path"),
            upstream_status: 0,
        })?;
        let response = self
            .client
            .get(url)
            .query(query)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| Failure {
                status: Status::unavailable("Kubernetes request failed"),
                upstream_status: 0,
            })?;
        let status = response.status().as_u16() as u32;
        if !response.status().is_success() {
            return Err(Failure {
                status: match status {
                    401 | 403 => Status::permission_denied("Kubernetes RBAC denied this operation"),
                    404 => Status::not_found("Kubernetes resource not found"),
                    _ => Status::unavailable("Kubernetes rejected this operation"),
                },
                upstream_status: status,
            });
        }
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(Failure {
                status: Status::resource_exhausted("Kubernetes response exceeds its byte budget"),
                upstream_status: status,
            });
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Failure {
                status: Status::unavailable("Kubernetes response interrupted"),
                upstream_status: status,
            })?;
            if bytes.len() + chunk.len() > limit {
                return Err(Failure {
                    status: Status::resource_exhausted(
                        "Kubernetes response exceeds its byte budget",
                    ),
                    upstream_status: status,
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok((bytes, status))
    }
}
#[async_trait::async_trait]
impl Connector for Kubernetes {
    fn id(&self) -> &str {
        &self.id
    }
    fn operations(&self, access: Option<&[PlatformConnectionScope]>) -> Vec<ConnectorOperation> {
        let definitions = [
            (
                "status",
                "Read namespaced pod status",
                "kubernetes.status.read",
            ),
            ("logs", "Read bounded pod logs", "kubernetes.logs.read"),
            (
                "events",
                "Read recent namespace events",
                "kubernetes.events.read",
            ),
        ];
        definitions.into_iter().filter_map(|(name, description, action)| {
            let targets: Vec<_> = self.namespaces.iter().filter_map(|namespace| {
                let resource = PlatformResource {
                    kind: "kubernetes.namespace".into(),
                    id: format!("{}/{}", self.id, namespace.uid),
                    target: String::new(),
                };
                allows_operation(access, action, &resource).then(|| ConnectorTarget {
                    name: namespace.name.clone(),
                    resource: Some(resource),
                })
            }).collect();
            if targets.is_empty() { return None; }
            let mut properties = serde_json::json!({"namespace":{"type":"string","enum":targets.iter().map(|target|&target.name).collect::<Vec<_>>()}});
            let mut required = vec!["namespace"];
            if name == "logs" {
                properties["pod"] = serde_json::json!({"type":"string"});
                properties["container"] = serde_json::json!({"type":"string"});
                properties["tail_lines"] = serde_json::json!({"type":"integer","minimum":1,"maximum":500});
                required.push("pod");
            }
            let schema = serde_json::json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
            Some(ConnectorOperation {
                connector_id: self.id.clone(),
                name: name.into(),
                description: description.into(),
                action: action.into(),
                input_schema_json: serde_json::to_vec(&schema).expect("static Kubernetes tool schema"),
                targets,
                read_only: true,
            })
        }).collect()
    }
    fn normalize(&self, operation: &str, arguments: &[u8]) -> Result<Normalized, Status> {
        if arguments.len() > 16_384 {
            return Err(Status::invalid_argument(
                "Kubernetes arguments exceed their byte budget",
            ));
        }
        let mut args: Arguments = serde_json::from_slice(arguments)
            .map_err(|_| Status::invalid_argument("invalid Kubernetes arguments"))?;
        let namespace = self
            .namespaces
            .iter()
            .find(|n| n.name == args.namespace)
            .ok_or_else(|| Status::permission_denied("namespace is not registered"))?;
        let mut query = Vec::new();
        let (action, path, target) = match operation {
            "status" | "events" => {
                if args.pod.is_some() || args.container.is_some() || args.tail_lines.is_some() {
                    return Err(Status::invalid_argument(
                        "arguments do not apply to this Kubernetes operation",
                    ));
                }
                query.push(("limit".into(), "100".into()));
                (
                    if operation == "status" {
                        "kubernetes.status.read"
                    } else {
                        "kubernetes.events.read"
                    },
                    format!(
                        "/api/v1/namespaces/{}/{}",
                        namespace.name,
                        if operation == "status" {
                            "pods"
                        } else {
                            "events"
                        }
                    ),
                    String::new(),
                )
            }
            "logs" => {
                let pod = args
                    .pod
                    .as_ref()
                    .filter(|p| name(p))
                    .ok_or_else(|| Status::invalid_argument("canonical pod name required"))?;
                if args.container.as_ref().is_some_and(|c| !name(c)) {
                    return Err(Status::invalid_argument("invalid container name"));
                }
                let tail = args.tail_lines.unwrap_or(100);
                if !(1..=500).contains(&tail) {
                    return Err(Status::invalid_argument(
                        "tail_lines must be between 1 and 500",
                    ));
                }
                args.tail_lines = Some(tail);
                query.extend([
                    ("tailLines".into(), tail.to_string()),
                    ("limitBytes".into(), "262144".into()),
                    ("timestamps".into(), "true".into()),
                ]);
                if let Some(container) = &args.container {
                    query.push(("container".into(), container.clone()));
                }
                (
                    "kubernetes.logs.read",
                    format!("/api/v1/namespaces/{}/pods/{pod}/log", namespace.name),
                    args.container.as_ref().map_or_else(
                        || format!("pod/{pod}"),
                        |container| format!("pod/{pod}/container/{container}"),
                    ),
                )
            }
            _ => {
                return Err(Status::unimplemented(
                    "Kubernetes operation is not registered",
                ));
            }
        };
        Ok(Normalized {
            action: action.into(),
            resources: vec![PlatformResource {
                kind: "kubernetes.namespace".into(),
                id: format!("{}/{}", self.id, namespace.uid),
                target,
            }],
            prepared_request: serde_json::to_vec(&PreparedRequest {
                operation: operation.into(),
                arguments: args,
                path,
                query,
            })
            .map_err(|_| Status::internal("encode prepared Kubernetes request"))?,
        })
    }
    async fn execute(&self, request: &Normalized) -> Result<Output, Failure> {
        let prepared: PreparedRequest =
            serde_json::from_slice(&request.prepared_request).map_err(|_| Failure {
                status: Status::internal("invalid prepared Kubernetes request"),
                upstream_status: 0,
            })?;
        let namespace = self
            .namespaces
            .iter()
            .find(|n| n.name == prepared.arguments.namespace)
            .ok_or_else(|| Failure {
                status: Status::permission_denied("namespace no longer registered"),
                upstream_status: 0,
            })?;
        let token = tokio::fs::read_to_string(&self.token_file)
            .await
            .map_err(|_| Failure {
                status: Status::unavailable("cluster credential unavailable"),
                upstream_status: 0,
            })?;
        let token = token.trim();
        if token.is_empty() || token.len() > 16_384 || token.contains(['\r', '\n']) {
            return Err(Failure {
                status: Status::unavailable("invalid cluster credential"),
                upstream_status: 0,
            });
        }
        let (identity, status) = self
            .read(
                &format!("/api/v1/namespaces/{}", namespace.name),
                &[],
                token,
                65536,
            )
            .await?;
        let identity: serde_json::Value =
            serde_json::from_slice(&identity).map_err(|_| Failure {
                status: Status::unavailable("invalid namespace identity response"),
                upstream_status: status,
            })?;
        if identity.pointer("/metadata/uid").and_then(|v| v.as_str())
            != Some(namespace.uid.as_str())
        {
            return Err(Failure {
                status: Status::permission_denied(
                    "namespace identity changed; policy onboarding is required",
                ),
                upstream_status: status,
            });
        }
        let (mut bytes, upstream_status) = self
            .read(&prepared.path, &prepared.query, token, 1_048_576)
            .await?;
        if prepared.operation != "logs" {
            let value =
                serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|_| Failure {
                    status: Status::unavailable("invalid Kubernetes JSON response"),
                    upstream_status,
                })?;
            if prepared.operation == "status" {
                let items = value
                    .get("items")
                    .and_then(serde_json::Value::as_array)
                    .ok_or_else(|| Failure {
                        status: Status::unavailable("invalid Kubernetes pod list"),
                        upstream_status,
                    })?;
                let items:Vec<_>=items.iter().map(|pod|serde_json::json!({"name":pod.pointer("/metadata/name"),"uid":pod.pointer("/metadata/uid"),"namespace":namespace.name,"phase":pod.pointer("/status/phase"),"conditions":pod.pointer("/status/conditions"),"containers":pod.pointer("/status/containerStatuses")})).collect();
                bytes=serde_json::to_vec(&serde_json::json!({"items":items,"continue":value.pointer("/metadata/continue")})).map_err(|_|Failure{status:Status::internal("encode Kubernetes pod status"),upstream_status})?;
            }
        }
        let (identity, status) = self
            .read(
                &format!("/api/v1/namespaces/{}", namespace.name),
                &[],
                token,
                65536,
            )
            .await?;
        let identity: serde_json::Value =
            serde_json::from_slice(&identity).map_err(|_| Failure {
                status: Status::unavailable("invalid namespace identity response"),
                upstream_status: status,
            })?;
        if identity.pointer("/metadata/uid").and_then(|v| v.as_str())
            != Some(namespace.uid.as_str())
        {
            return Err(Failure {
                status: Status::permission_denied("namespace identity changed during execution"),
                upstream_status: status,
            });
        }
        Ok(Output {
            bytes,
            content_type: if prepared.operation == "logs" {
                "text/plain; charset=utf-8"
            } else {
                "application/json"
            }
            .into(),
            upstream_status,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn connector() -> Kubernetes {
        Kubernetes {
            id: "galactic".into(),
            endpoint: "https://kubernetes.default.svc/".parse().unwrap(),
            token_file: "/not-used-by-normalization".into(),
            namespaces: vec![Namespace {
                name: "ofz".into(),
                uid: "11111111-1111-4111-8111-111111111111".into(),
            }],
            client: reqwest::Client::new(),
        }
    }
    #[test]
    fn discovery_excludes_unapproved_actions_targets_and_schema_values() {
        let mut connector = connector();
        connector.namespaces.push(Namespace {
            name: "private-workspace".into(),
            uid: "22222222-2222-4222-8222-222222222222".into(),
        });
        let scopes = [PlatformConnectionScope {
            resource: Some(PlatformResource {
                kind: "kubernetes.namespace".into(),
                id: "galactic/11111111-1111-4111-8111-111111111111".into(),
                target: String::new(),
            }),
            actions: vec!["kubernetes.status.read".into()],
            ..Default::default()
        }];
        let operations = connector.operations(Some(&scopes));
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].name, "status");
        assert_eq!(operations[0].targets.len(), 1);
        assert_eq!(operations[0].targets[0].name, "ofz");
        let schema: serde_json::Value =
            serde_json::from_slice(&operations[0].input_schema_json).unwrap();
        assert_eq!(
            schema["properties"]["namespace"]["enum"],
            serde_json::json!(["ofz"])
        );
        assert!(connector.operations(Some(&[])).is_empty());
        assert_eq!(connector.operations(None).len(), 3);
    }
    #[test]
    fn logs_bind_the_exact_namespace_pod_container_and_limits() {
        let connector = connector();
        let request = connector
            .normalize(
                "logs",
                br#"{"namespace":"ofz","pod":"ofz-db-1","container":"postgres"}"#,
            )
            .unwrap();
        assert_eq!(request.action, "kubernetes.logs.read");
        assert_eq!(
            request.resources[0].id,
            "galactic/11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(
            request.resources[0].target,
            "pod/ofz-db-1/container/postgres"
        );
        let prepared: PreparedRequest = serde_json::from_slice(&request.prepared_request).unwrap();
        assert_eq!(prepared.path, "/api/v1/namespaces/ofz/pods/ofz-db-1/log");
        assert!(prepared.query.contains(&("tailLines".into(), "100".into())));
        assert!(
            prepared
                .query
                .contains(&("limitBytes".into(), "262144".into()))
        );
        let default = connector
            .normalize("logs", br#"{"namespace":"ofz","pod":"ofz-db-1"}"#)
            .unwrap();
        assert_eq!(default.resources[0].target, "pod/ofz-db-1");
    }
    #[test]
    fn untrusted_arguments_cannot_add_methods_paths_credentials_or_unbounded_streams() {
        let connector = connector();
        for operation in [
            "exec",
            "delete",
            "patch",
            "secrets",
            "portforward",
            "/api/v1/secrets",
        ] {
            assert!(
                connector
                    .normalize(operation, br#"{"namespace":"ofz"}"#)
                    .is_err()
            );
        }
        for arguments in [
            r#"{"namespace":"kube-system"}"#,
            r#"{"namespace":"ofz","url":"https://metadata.internal"}"#,
            r#"{"namespace":"ofz","pod":"../../secrets"}"#,
            r#"{"namespace":"ofz","pod":"p%2flog"}"#,
            r#"{"namespace":"ofz","pod":"pod","follow":true}"#,
            r#"{"namespace":"ofz","pod":"pod","tail_lines":501}"#,
            r#"{"namespace":"ofz","pod":"pod","tail_lines":0}"#,
        ] {
            assert!(
                connector.normalize("logs", arguments.as_bytes()).is_err(),
                "{arguments}"
            );
        }
        assert!(
            connector
                .normalize("status", br#"{"namespace":"ofz","pod":"ofz-db-1"}"#)
                .is_err()
        );
    }
}
