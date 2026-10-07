use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use anyhow::{Context, ensure};
use k8s_openapi::api::core::v1::Pod;
use kube::ResourceExt;

use super::{Claim, runner, runner::SlotStatus};
use crate::{crd::MicroVM, identity::WorkloadIdentity};

pub struct SlotClient {
    http: reqwest::Client,
    url: String,
    pod_uid: String,
    pvc_uid: String,
    image: String,
}

impl SlotClient {
    pub fn new(
        identity: &WorkloadIdentity,
        namespace: &str,
        pod: &Pod,
        pvc_uid: &str,
        image: &str,
    ) -> anyhow::Result<Self> {
        let pod_uid = pod.uid().context("slot Pod has no UID")?;
        let ip: IpAddr = pod
            .status
            .as_ref()
            .and_then(|s| s.pod_ip.as_ref())
            .context("slot Pod has no IP")?
            .parse()?;
        let tls = identity
            .guest_tls(identity.guest_id(namespace, &pod_uid)?)?
            .context("slot requires SPIFFE mutual TLS")?;
        let mut tls = tls.as_ref().clone();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(runner::COMMAND_TIMEOUT + Duration::from_secs(10))
            .build()?;
        Ok(Self {
            http,
            url: format!("https://{}", SocketAddr::new(ip, 8443)),
            pod_uid,
            pvc_uid: pvc_uid.into(),
            image: image.into(),
        })
    }

    pub async fn status(&self) -> anyhow::Result<SlotStatus> {
        let response = self
            .http
            .get(format!("{}/slot/status", self.url))
            .send()
            .await?;
        self.decode(response).await
    }

    pub async fn lifecycle(&self, action: &str, claim: &Claim) -> anyhow::Result<SlotStatus> {
        ensure!(
            ["restore", "sleep", "stop"].contains(&action),
            "invalid slot command"
        );
        claim.validate()?;
        let response = self
            .http
            .post(format!("{}/slot/{action}", self.url))
            .json(claim)
            .send()
            .await?;
        let status = self.decode(response).await?;
        ensure!(
            status.state.claim() == Some(claim),
            "supervisor returned a different owner or epoch"
        );
        Ok(status)
    }

    async fn decode(&self, mut response: reqwest::Response) -> anyhow::Result<SlotStatus> {
        let code = response.status();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                body.len() + chunk.len() <= 16384,
                "supervisor response exceeds its limit"
            );
            body.extend_from_slice(&chunk);
        }
        ensure!(
            code.is_success(),
            "supervisor lifecycle failed: {}",
            String::from_utf8_lossy(&body)
        );
        let status: SlotStatus = serde_json::from_slice(&body)?;
        ensure!(
            status.identity.pod_uid == self.pod_uid
                && status.identity.pvc_uid == self.pvc_uid
                && status.identity.image == self.image,
            "supervisor Pod, home, or image identity changed"
        );
        Ok(status)
    }
}

pub fn claim_for(microvm: &MicroVM) -> anyhow::Result<Claim> {
    let slot = microvm
        .spec
        .slot
        .as_ref()
        .context("agent has no prepared slot")?;
    let claim = Claim {
        microvm_id: microvm.name_any(),
        microvm_uid: microvm.uid().context("MicroVM has no UID")?,
        epoch: slot.epoch,
    };
    claim.validate()?;
    Ok(claim)
}
