use chrono::{DateTime, Utc};
use k8s_openapi::api::{
    authentication::v1::{BoundObjectReference, TokenRequest, TokenRequestSpec},
    core::v1::{Pod, ServiceAccount},
};
use kube::{
    Api, ResourceExt,
    api::{Patch, PatchParams, PostParams},
};
use serde_json::json;

use crate::{controller::ControllerContext, crd::MicroVM, guest::GuestClient};

const EXPIRES_AT: &str = "runtime.proompteng.ai/spire-bootstrap-expires-at";

pub async fn refresh(
    context: &ControllerContext,
    microvm: &MicroVM,
    pod: &Pod,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    #[cfg(test)]
    if matches!(context.identity, crate::identity::WorkloadIdentity::Fixture) {
        return Ok(());
    }

    let uid = pod
        .uid()
        .ok_or_else(|| anyhow::anyhow!("guest Pod UID is unavailable"))?;
    if microvm
        .status
        .as_ref()
        .and_then(|status| status.pod_uid.as_deref())
        != Some(&uid)
    {
        return Ok(());
    }
    if pod
        .annotations()
        .get(EXPIRES_AT)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|expires| expires > now + chrono::Duration::minutes(5))
    {
        return Ok(());
    }
    let guest = GuestClient::for_agent(
        context.client.clone(),
        &context.namespace,
        &microvm.name_any(),
        &context.identity,
    )
    .await?;
    let accounts: Api<ServiceAccount> = Api::namespaced(context.client.clone(), &context.namespace);
    let request = TokenRequest {
        spec: Some(TokenRequestSpec {
            audiences: Some(vec!["spire-server".to_owned()]),
            expiration_seconds: Some(600),
            bound_object_ref: Some(BoundObjectReference {
                api_version: Some("v1".to_owned()),
                kind: Some("Pod".to_owned()),
                name: Some(pod.name_any()),
                uid: Some(uid.clone()),
            }),
        }),
        ..TokenRequest::default()
    };
    let response = accounts
        .create_token_request("nanoagent", &PostParams::default(), &request)
        .await?;
    let status = response
        .status
        .ok_or_else(|| anyhow::anyhow!("SPIRE TokenRequest has no status"))?;
    let token = status
        .token
        .ok_or_else(|| anyhow::anyhow!("SPIRE TokenRequest has no token"))?;
    let expires = status
        .expiration_timestamp
        .ok_or_else(|| anyhow::anyhow!("SPIRE TokenRequest has no expiration"))?;
    let bundle = context.identity.bundle_pem()?;
    guest
        .rpc
        .refresh_spire_bootstrap(&uid, token.into_bytes(), bundle)
        .await?;
    let pods: Api<Pod> = Api::namespaced(context.client.clone(), &context.namespace);
    pods.patch(
        &pod.name_any(),
        &PatchParams::default(),
        &Patch::Merge(json!({
            "metadata": {"uid": uid, "resourceVersion": pod.resource_version(), "annotations": {
                EXPIRES_AT: expires.0.to_string(),
            }},
        })),
    )
    .await?;
    Ok(())
}

fn entries(client: kube::Client) -> Api<kube::core::DynamicObject> {
    let resource = kube::core::ApiResource::from_gvk_with_plural(
        &kube::core::GroupVersionKind::gvk("spire.spiffe.io", "v1alpha1", "ClusterStaticEntry"),
        "clusterstaticentries",
    );
    Api::all_with(client, &resource)
}

pub async fn ensure_registration(
    context: &ControllerContext,
    microvm: &MicroVM,
    pod: &Pod,
) -> anyhow::Result<()> {
    #[cfg(test)]
    if matches!(context.identity, crate::identity::WorkloadIdentity::Fixture) {
        return Ok(());
    }
    let uid = pod
        .uid()
        .ok_or_else(|| anyhow::anyhow!("guest Pod UID is unavailable"))?;
    let id = context.identity.guest_id(&context.namespace, &uid)?;
    register(&entries(context.client.clone()), microvm, &uid, &id).await
}

async fn register(
    api: &Api<kube::core::DynamicObject>,
    microvm: &MicroVM,
    uid: &str,
    id: &spiffe::SpiffeId,
) -> anyhow::Result<()> {
    let owner = microvm
        .uid()
        .ok_or_else(|| anyhow::anyhow!("MicroVM UID is unavailable"))?;
    let domain = id
        .to_string()
        .split("/ns/")
        .next()
        .ok_or_else(|| anyhow::anyhow!("guest SPIFFE trust domain is unavailable"))?
        .to_owned();
    let name = format!("nanoagent-{uid}");
    let body = json!({
        "apiVersion": "spire.spiffe.io/v1alpha1", "kind": "ClusterStaticEntry",
        "metadata": {"name": name, "labels": {
            "app.kubernetes.io/managed-by": "tengri", "runtime.proompteng.ai/microvm-uid": owner,
        }},
        "spec": {
            "className": "spire-server-spire", "spiffeID": id.to_string(),
            "parentID": format!("{domain}/spire/agent/k8s_psat/galactic-guests/pod/{uid}"),
            "selectors": ["unix:uid:1000"], "x509SVIDTTL": "2m", "jwtSVIDTTL": "2m",
            "admin": false, "downstream": false, "storeSVID": false,
        },
    });
    api.patch(
        &name,
        &PatchParams::apply("tengri.runtime.proompteng.ai"),
        &Patch::Apply(body),
    )
    .await?;
    remove(api, microvm, Some(&name)).await
}

pub async fn remove_registrations(
    context: &ControllerContext,
    microvm: &MicroVM,
    keep: Option<&str>,
) -> anyhow::Result<()> {
    #[cfg(test)]
    if matches!(context.identity, crate::identity::WorkloadIdentity::Fixture) {
        return Ok(());
    }
    remove(&entries(context.client.clone()), microvm, keep).await
}

async fn remove(
    api: &Api<kube::core::DynamicObject>,
    microvm: &MicroVM,
    keep: Option<&str>,
) -> anyhow::Result<()> {
    let uid = microvm
        .uid()
        .ok_or_else(|| anyhow::anyhow!("MicroVM UID is unavailable"))?;
    let selector =
        format!("app.kubernetes.io/managed-by=tengri,runtime.proompteng.ai/microvm-uid={uid}");
    for entry in api
        .list(&kube::api::ListParams::default().labels(&selector))
        .await?
        .items
    {
        let name = entry.name_any();
        if keep == Some(name.as_str()) {
            continue;
        }
        if !name.starts_with("nanoagent-") {
            anyhow::bail!("guest SPIRE entry has an unexpected name")
        }
        let params = kube::api::DeleteParams {
            preconditions: Some(kube::api::Preconditions {
                uid: entry.uid(),
                resource_version: entry.resource_version(),
            }),
            ..Default::default()
        };
        api.delete(&name, &params).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn registration_replaces_only_the_previous_pod_entry_with_delete_preconditions() {
        const CURRENT: &str = "11111111-1111-1111-1111-111111111111";
        const PREVIOUS: &str = "22222222-2222-2222-2222-222222222222";
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let service = tower::service_fn(move |request: http::Request<kube::client::Body>| {
            let captured = captured.clone();
            async move {
                let method = request.method().clone();
                let path = request.uri().path().to_owned();
                let query = request.uri().query().unwrap_or_default().to_owned();
                let bytes = request.into_body().collect().await.unwrap().to_bytes();
                let body: serde_json::Value = if bytes.is_empty() {
                    json!(null)
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                let response = match method {
                    http::Method::PATCH => body.clone(),
                    http::Method::GET => {
                        json!({"apiVersion":"spire.spiffe.io/v1alpha1", "kind":"ClusterStaticEntryList", "metadata":{}, "items":[
                            {"apiVersion":"spire.spiffe.io/v1alpha1","kind":"ClusterStaticEntry", "metadata":{"name":format!("nanoagent-{CURRENT}"),"uid":"current-entry-uid","resourceVersion":"8"}},
                            {"apiVersion":"spire.spiffe.io/v1alpha1","kind":"ClusterStaticEntry", "metadata":{"name":format!("nanoagent-{PREVIOUS}"),"uid":"previous-entry-uid","resourceVersion":"7"}}
                        ]})
                    }
                    http::Method::DELETE => {
                        json!({"apiVersion":"v1", "kind":"Status", "status":"Success"})
                    }
                    _ => panic!("unexpected registration request"),
                };
                captured.lock().unwrap().push((method, path, query, body));
                Ok::<_, std::convert::Infallible>(
                    http::Response::builder()
                        .header("content-type", "application/json")
                        .body(kube::client::Body::from(
                            serde_json::to_vec(&response).unwrap(),
                        ))
                        .unwrap(),
                )
            }
        });
        let client = kube::Client::new(service, "tengri");
        let api = entries(client);
        let microvm: MicroVM = serde_json::from_value(json!({
            "apiVersion":"runtime.proompteng.ai/v1alpha1","kind":"MicroVM","metadata":{"name":"agent-fixture","uid":"microvm-uid"},
            "spec":{"displayName":"fixture","ownerHash":"a".repeat(64),"desiredState":"Running","image":"test","architecture":"amd64", "resources":{"cpuMillis":2000,"memoryMib":4096,"workspaceGib":16},"createdAt":"2026-10-01T00:00:00Z","idleDeadline":"2099-01-01T00:00:00Z"}
        })).unwrap();
        let id = format!("spiffe://proompteng.ai/ns/tengri/nanoagent/pod/{CURRENT}")
            .parse()
            .unwrap();
        register(&api, &microvm, CURRENT, &id).await.unwrap();
        {
            let calls = requests.lock().unwrap();
            assert_eq!(calls.len(), 3);
            assert_eq!(
                calls[0].1,
                format!("/apis/spire.spiffe.io/v1alpha1/clusterstaticentries/nanoagent-{CURRENT}")
            );
            assert_eq!(
                calls[0].3["spec"]["parentID"],
                format!(
                    "spiffe://proompteng.ai/spire/agent/k8s_psat/galactic-guests/pod/{CURRENT}"
                )
            );
            assert_eq!(calls[0].3["spec"]["selectors"], json!(["unix:uid:1000"]));
            assert!(calls[1].2.contains("microvm-uid"));
            assert_eq!(
                calls[2].1,
                format!("/apis/spire.spiffe.io/v1alpha1/clusterstaticentries/nanoagent-{PREVIOUS}")
            );
            assert_eq!(
                calls[2].3["preconditions"],
                json!({"uid":"previous-entry-uid","resourceVersion":"7"})
            );
        }
        remove(&api, &microvm, None).await.unwrap();
        let calls = requests.lock().unwrap();
        assert_eq!(calls.len(), 6);
        assert_eq!(
            calls[4].3["preconditions"],
            json!({"uid":"current-entry-uid","resourceVersion":"8"})
        );
    }
}
