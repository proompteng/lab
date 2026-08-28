use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::Context as _;
use k8s_openapi::api::core::v1::Pod;
use kube::{Api, Client, api::DeleteParams};
use tokio::{fs, time::sleep};
use tracing::warn;

const INTERNAL_HMAC_FILE: &str = "TENGRI_INTERNAL_HMAC_SECRET";
const TICKET_SIGNING_FILE: &str = "TENGRI_TICKET_SIGNING_SECRET";

pub(crate) struct RuntimeSecretSnapshot {
    internal_hmac: Vec<u8>,
    ticket_signing: Vec<u8>,
}

impl RuntimeSecretSnapshot {
    pub(crate) fn new(internal_hmac: &str, ticket_signing: &str) -> Self {
        Self {
            internal_hmac: internal_hmac.as_bytes().to_vec(),
            ticket_signing: ticket_signing.as_bytes().to_vec(),
        }
    }
}

pub(crate) async fn watch(
    directory: PathBuf,
    expected: RuntimeSecretSnapshot,
    poll_interval: Duration,
) {
    loop {
        match (
            read_key(&directory, INTERNAL_HMAC_FILE).await,
            read_key(&directory, TICKET_SIGNING_FILE).await,
        ) {
            (Ok(internal_hmac), Ok(ticket_signing)) => {
                if internal_hmac != expected.internal_hmac
                    || ticket_signing != expected.ticket_signing
                {
                    return;
                }
            }
            (internal_hmac, ticket_signing) => {
                warn!(
                    internal_hmac_available = internal_hmac.is_ok(),
                    ticket_signing_available = ticket_signing.is_ok(),
                    "projected runtime secret is temporarily unavailable"
                );
            }
        }
        sleep(poll_interval).await;
    }
}

pub(crate) async fn replace_pod(
    client: Client,
    namespace: &str,
    pod_name: &str,
) -> anyhow::Result<()> {
    Api::<Pod>::namespaced(client, namespace)
        .delete(pod_name, &DeleteParams::default())
        .await
        .with_context(|| format!("delete Tengri Pod {pod_name} after runtime secret rotation"))?;
    Ok(())
}

async fn read_key(directory: &Path, name: &str) -> anyhow::Result<Vec<u8>> {
    fs::read(directory.join(name))
        .await
        .with_context(|| format!("read projected runtime secret key {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::{Method, Request, Response, StatusCode};
    use kube::client::Body as KubeBody;
    use uuid::Uuid;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        async fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("tengri-runtime-secret-{}", Uuid::new_v4()));
            fs::create_dir_all(&path)
                .await
                .expect("create test directory");
            Self(path)
        }

        async fn write(&self, name: &str, value: &str) {
            fs::write(self.0.join(name), value)
                .await
                .expect("write projected secret key");
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn matching_projection_remains_healthy() {
        let directory = TestDirectory::new().await;
        directory.write(INTERNAL_HMAC_FILE, "current-hmac").await;
        directory.write(TICKET_SIGNING_FILE, "current-ticket").await;

        let result = tokio::time::timeout(
            Duration::from_millis(30),
            watch(
                directory.0.clone(),
                RuntimeSecretSnapshot::new("current-hmac", "current-ticket"),
                Duration::from_millis(5),
            ),
        )
        .await;

        assert!(
            result.is_err(),
            "matching projection must keep the watcher pending"
        );
    }

    #[tokio::test]
    async fn projection_change_requests_restart_without_exposing_values() {
        let directory = TestDirectory::new().await;
        directory.write(INTERNAL_HMAC_FILE, "original-hmac").await;
        directory
            .write(TICKET_SIGNING_FILE, "original-ticket")
            .await;
        let watcher = tokio::spawn(watch(
            directory.0.clone(),
            RuntimeSecretSnapshot::new("original-hmac", "original-ticket"),
            Duration::from_millis(5),
        ));

        tokio::time::sleep(Duration::from_millis(15)).await;
        directory.write(TICKET_SIGNING_FILE, "rotated-ticket").await;
        tokio::time::timeout(Duration::from_millis(250), watcher)
            .await
            .expect("watcher detects rotation")
            .expect("watcher task");
    }

    #[tokio::test]
    async fn rotation_requests_a_replacement_pod() {
        let (service, mut handle) =
            tower_test::mock::pair::<Request<KubeBody>, Response<KubeBody>>();
        let client = Client::new(service, "tengri");
        let replacement = tokio::spawn(replace_pod(client, "tengri", "tengri-controller"));
        let (request, response) = handle.next_request().await.expect("Pod deletion request");

        assert_eq!(request.method(), Method::DELETE);
        assert_eq!(
            request.uri().path(),
            "/api/v1/namespaces/tengri/pods/tengri-controller"
        );
        response.send_response(
            Response::builder()
                .status(StatusCode::OK)
                .header(http::header::CONTENT_TYPE, "application/json")
                .body(KubeBody::from(
                    br#"{"apiVersion":"v1","kind":"Pod","metadata":{"name":"tengri-controller","namespace":"tengri"}}"#
                        .to_vec(),
                ))
                .expect("Pod deletion response"),
        );
        replacement
            .await
            .expect("replacement task")
            .expect("Pod replacement request");
    }
}
