use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use anyhow::{Context, bail, ensure};
use k8s_openapi::api::core::v1::Pod;
use kube::ResourceExt;

use super::{Allocation, Claim, runner, runner::SlotStatus};
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
        #[cfg(test)]
        if let WorkloadIdentity::Fixture(port) = identity {
            return Ok(Self {
                http: reqwest::Client::builder()
                    .no_proxy()
                    .timeout(runner::COMMAND_TIMEOUT + Duration::from_secs(10))
                    .build()?,
                url: format!("http://{}", SocketAddr::new(ip, *port)),
                pod_uid,
                pvc_uid: pvc_uid.into(),
                image: image.into(),
            });
        }
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
            .headers(crate::telemetry::headers())
            .send()
            .await?;
        self.decode(response).await
    }

    pub async fn install_fence(&self, fence: crate::control::Fence) -> anyhow::Result<()> {
        fence.validate()?;
        let response = self
            .http
            .post(format!("{}/slot/fence", self.url))
            .timeout(Duration::from_secs(2))
            .json(&fence)
            .headers(crate::telemetry::headers())
            .send()
            .await?;
        ensure!(
            response.status().is_success(),
            "supervisor rejected controller fencing generation"
        );
        Ok(())
    }

    pub async fn lifecycle(
        &self,
        action: &str,
        claim: &Claim,
        fence: crate::control::Fence,
    ) -> anyhow::Result<SlotStatus> {
        ensure!(["sleep", "stop"].contains(&action), "invalid slot command");
        claim.validate()?;
        self.install_fence(fence).await?;
        self.send_lifecycle(action, claim, fence).await
    }

    pub async fn restore(
        &self,
        microvm: &MicroVM,
        authorization: &crate::authz::WorkspaceAuthorization,
        leadership: &crate::leadership::Guard,
    ) -> anyhow::Result<SlotStatus> {
        let installed = leadership.fence()?;
        self.install_fence(installed).await?;
        let authority = authorization.runtime_state(microvm).await?;
        let binding = microvm.spec.slot.as_ref().context("missing slot binding")?;
        ensure!(
            authority.runtime_allowed
                && authority.running
                && authority.state == "active"
                && Some(authority.workspace_uid.as_str()) == microvm.uid().as_deref()
                && authority.owner_id == microvm.spec.owner_hash
                && authority.runtime_epoch == microvm.spec.runtime_epoch
                && authority.policy_version == microvm.spec.policy_version
                && authority.reservation_id == microvm.spec.reservation_id
                && authority.home_uid == binding.pvc_uid
                && authority.home_uid == self.pvc_uid,
            "Ofz runtime authority changed before restore"
        );
        let fence = leadership.fence()?;
        ensure!(
            fence.owner == installed.owner && fence.generation == installed.generation,
            "controller leadership changed before restore"
        );
        ensure!(
            crate::ofz::now_ms()? < authority.valid_until_unix_ms,
            "Ofz runtime authority expired before restore"
        );
        self.send_lifecycle("restore", &claim_for(microvm)?, fence)
            .await
    }

    #[cfg(all(test, target_os = "linux"))]
    pub async fn fixture_restore(
        &self,
        claim: &Claim,
        fence: crate::control::Fence,
    ) -> anyhow::Result<SlotStatus> {
        claim.validate()?;
        self.install_fence(fence).await?;
        self.send_lifecycle("restore", claim, fence).await
    }

    pub async fn stop(
        &self,
        allocation: &Allocation,
        fence: crate::control::Fence,
    ) -> anyhow::Result<SlotStatus> {
        allocation.validate()?;
        self.install_fence(fence).await?;
        let current = self.status().await?;
        let claim = match current.state.claim() {
            Some(claim) if claim.allocation() == *allocation => claim.clone(),
            None if matches!(
                current.state,
                super::SlotState::Vacant { .. } | super::SlotState::Failed { claim: None, .. }
            ) =>
            {
                Claim {
                    microvm_id: allocation.microvm_id.clone(),
                    microvm_uid: allocation.microvm_uid.clone(),
                    epoch: allocation.epoch,
                    runtime_epoch: crate::ofz::operation_id(
                        &format!("{}:{}", allocation.microvm_uid, allocation.epoch),
                        "slot-retirement",
                    ),
                }
            }
            _ => bail!("slot owner or epoch changed before termination"),
        };
        claim.validate()?;
        self.send_lifecycle("stop", &claim, fence).await
    }

    async fn send_lifecycle(
        &self,
        action: &str,
        claim: &Claim,
        fence: crate::control::Fence,
    ) -> anyhow::Result<SlotStatus> {
        let response = self
            .http
            .post(format!("{}/slot/{action}", self.url))
            .header(
                super::supervisor::LEADER_OWNER_HEADER,
                fence.owner.to_string(),
            )
            .header(
                super::supervisor::LEADER_GENERATION_HEADER,
                fence.generation.to_string(),
            )
            .json(claim)
            .headers(crate::telemetry::headers())
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

pub fn allocation_for(microvm: &MicroVM) -> anyhow::Result<Allocation> {
    let slot = microvm
        .spec
        .slot
        .as_ref()
        .context("agent has no prepared slot")?;
    let allocation = Allocation {
        microvm_id: microvm.name_any(),
        microvm_uid: microvm.uid().context("MicroVM has no UID")?,
        epoch: slot.epoch,
    };
    allocation.validate()?;
    Ok(allocation)
}

pub fn claim_for(microvm: &MicroVM) -> anyhow::Result<Claim> {
    let allocation = allocation_for(microvm)?;
    let claim = Claim {
        microvm_id: allocation.microvm_id,
        microvm_uid: allocation.microvm_uid,
        epoch: allocation.epoch,
        runtime_epoch: microvm.spec.runtime_epoch.clone(),
    };
    claim.validate()?;
    Ok(claim)
}
