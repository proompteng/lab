pub mod client;
#[cfg(all(test, target_os = "linux"))]
mod kvm_test;
pub mod runner;
pub mod supervisor;
mod vmm;

use std::{path::PathBuf, time::Duration};

use anyhow::{Context, bail, ensure};
use serde::{Deserialize, Serialize};
use tokio::{fs, sync::watch};
use vmm::Vmm;

pub const FIRECRACKER_VERSION: &str = "1.16.1";
pub const GUEST_API_PORT: u32 = 1024;
pub const GUEST_CONTROL_PORT: u32 = 1025;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Claim {
    pub microvm_id: String,
    pub microvm_uid: String,
    pub epoch: u64,
}

impl Claim {
    pub fn validate(&self) -> anyhow::Result<()> {
        for value in [&self.microvm_id, &self.microvm_uid] {
            ensure!(
                !value.is_empty()
                    && value.len() <= 63
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
                "invalid slot owner"
            );
        }
        ensure!(self.epoch > 0, "slot epoch must be positive");
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlotIdentity {
    pub pod_uid: String,
    pub pvc_uid: String,
    pub image: String,
    pub kernel_sha256: String,
    pub firecracker_version: String,
    pub cpu: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub generation: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "phase", rename_all = "camelCase", deny_unknown_fields)]
pub enum SlotState {
    Preparing,
    Vacant {
        snapshot: Snapshot,
    },
    Restoring {
        claim: Claim,
        generation: u64,
    },
    Awake {
        claim: Claim,
    },
    Saving {
        claim: Claim,
    },
    Sleeping {
        claim: Claim,
        snapshot: Snapshot,
    },
    Failed {
        claim: Option<Claim>,
        message: String,
    },
    Stopped {
        claim: Claim,
    },
    Stopping {
        claim: Claim,
    },
}

impl SlotState {
    pub fn claim(&self) -> Option<&Claim> {
        match self {
            Self::Restoring { claim, .. }
            | Self::Awake { claim }
            | Self::Saving { claim }
            | Self::Sleeping { claim, .. }
            | Self::Stopping { claim }
            | Self::Stopped { claim } => Some(claim),
            Self::Failed { claim, .. } => claim.as_ref(),
            Self::Preparing | Self::Vacant { .. } => None,
        }
    }

    fn restore_snapshot(&self, claim: &Claim) -> anyhow::Result<&Snapshot> {
        claim.validate()?;
        match self {
            Self::Vacant { snapshot } => Ok(snapshot),
            Self::Sleeping {
                claim: owner,
                snapshot,
            } if owner == claim => Ok(snapshot),
            _ => bail!("slot has no committed snapshot for this owner and epoch"),
        }
    }

    pub fn serves(&self, claim: &Claim) -> bool {
        matches!(self, Self::Awake { claim: owner } if owner == claim)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    identity: SlotIdentity,
    next_generation: u64,
    state: SlotState,
}

#[derive(Clone)]
pub struct SlotConfig {
    pub identity: SlotIdentity,
    pub directory: PathBuf,
    pub sockets: PathBuf,
    pub firecracker: PathBuf,
    pub kernel: PathBuf,
    pub root_disk: PathBuf,
    pub home_disk: PathBuf,
    pub tap: String,
    pub memory_mib: u32,
    pub vcpus: u8,
}

impl SlotConfig {
    fn snapshot_dir(&self, generation: u64) -> PathBuf {
        self.directory.join(format!("snapshot-{generation}"))
    }

    pub fn vsock(&self) -> PathBuf {
        self.sockets.join("guest.vsock")
    }
}

pub struct Slot {
    config: SlotConfig,
    journal: Journal,
    vm: Option<Vmm>,
    state_tx: watch::Sender<SlotState>,
}

impl Slot {
    pub async fn open(config: SlotConfig) -> anyhow::Result<Self> {
        ensure!(
            config.identity.firecracker_version == FIRECRACKER_VERSION,
            "unexpected VMM version"
        );
        ensure!(
            config.memory_mib == 8192 && config.vcpus == 4,
            "unexpected guest resource profile"
        );
        fs::create_dir_all(&config.directory).await?;
        fs::create_dir_all(&config.sockets).await?;
        let journal_path = config.directory.join("journal.json");
        let journal = match fs::read(&journal_path).await {
            Ok(bytes) => {
                let journal: Journal =
                    serde_json::from_slice(&bytes).context("read slot journal")?;
                ensure!(
                    journal.identity == config.identity,
                    "snapshot identity changed; retain the claim and require explicit fenced recovery"
                );
                ensure!(journal.next_generation > 0, "invalid snapshot generation");
                ensure!(
                    matches!(
                        journal.state,
                        SlotState::Vacant { .. }
                            | SlotState::Sleeping { .. }
                            | SlotState::Failed { .. }
                            | SlotState::Stopped { .. }
                    ),
                    "runner restarted during an active VM; retain the claim and require explicit fenced recovery"
                );
                journal
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Journal {
                identity: config.identity.clone(),
                next_generation: 1,
                state: SlotState::Preparing,
            },
            Err(error) => return Err(error).context("read slot journal"),
        };
        let (state_tx, _) = watch::channel(journal.state.clone());
        let slot = Self {
            config,
            journal,
            vm: None,
            state_tx,
        };
        slot.persist().await?;
        Ok(slot)
    }

    pub fn state(&self) -> &SlotState {
        &self.journal.state
    }

    pub fn subscribe(&self) -> watch::Receiver<SlotState> {
        self.state_tx.subscribe()
    }

    async fn refresh_liveness(&mut self) {
        if !matches!(self.state(), SlotState::Awake { .. }) {
            return;
        }
        let running = match &mut self.vm {
            Some(vm) => vm.running(),
            None => Ok(false),
        };
        if !matches!(running, Ok(true)) {
            let error = match running {
                Ok(_) => anyhow::anyhow!("Firecracker exited while the guest was awake"),
                Err(error) => error.context("cannot verify Firecracker liveness"),
            };
            self.fail(&error).await;
        }
    }

    async fn persist(&self) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec(&self.journal)?;
        let path = self.config.directory.join("journal.json");
        tokio::task::spawn_blocking(move || durable_replace(&path, &bytes)).await??;
        Ok(())
    }

    async fn transition(&mut self, state: SlotState) -> anyhow::Result<()> {
        self.journal.state = state;
        // Fence new operations even when the durability write fails.
        self.state_tx.send_replace(self.journal.state.clone());
        self.persist().await
    }

    pub async fn prepare(&mut self) -> anyhow::Result<()> {
        ensure!(
            matches!(self.state(), SlotState::Preparing),
            "slot is already prepared"
        );
        let result = self.prepare_vm().await;
        if let Err(error) = &result {
            self.fail(error).await;
        }
        result
    }

    async fn prepare_vm(&mut self) -> anyhow::Result<()> {
        self.vm = Some(Vmm::boot(&self.config).await?);
        vmm::wait_guest(&self.config.vsock(), Duration::from_secs(35 * 60)).await?;
        let snapshot = self.save_vm().await?;
        self.transition(SlotState::Vacant { snapshot }).await
    }

    pub async fn restore(&mut self, claim: Claim) -> anyhow::Result<()> {
        if self.state().serves(&claim) {
            return Ok(());
        }
        let snapshot = self.state().restore_snapshot(&claim)?.clone();
        // The disk may advance as soon as vCPUs run. Consume the snapshot durably first.
        self.transition(SlotState::Restoring {
            claim: claim.clone(),
            generation: snapshot.generation,
        })
        .await?;
        let result = self.restore_vm(&snapshot, &claim).await;
        if let Err(error) = &result {
            self.fail(error).await;
        }
        result
    }

    async fn restore_vm(&mut self, snapshot: &Snapshot, claim: &Claim) -> anyhow::Result<()> {
        self.vm =
            Some(Vmm::load(&self.config, &self.config.snapshot_dir(snapshot.generation)).await?);
        self.vm
            .as_ref()
            .context("missing restored VMM")?
            .resume()
            .await?;
        let reply = vmm::guest_command(&self.config.vsock(), &serde_json::json!({
            "action": "resume", "claim": claim, "unixTimeNanos": chrono::Utc::now().timestamp_nanos_opt().context("host clock overflow")?
        })).await?;
        ensure!(
            reply.get("claim") == Some(&serde_json::to_value(claim)?),
            "restored guest claim does not match its slot"
        );
        self.transition(SlotState::Awake {
            claim: claim.clone(),
        })
        .await
    }

    pub async fn sleep(&mut self, claim: &Claim) -> anyhow::Result<()> {
        claim.validate()?;
        if let SlotState::Vacant { snapshot } = self.state() {
            return self
                .transition(SlotState::Sleeping {
                    claim: claim.clone(),
                    snapshot: snapshot.clone(),
                })
                .await;
        }
        if matches!(self.state(), SlotState::Sleeping { claim: owner, .. } if owner == claim) {
            return Ok(());
        }
        ensure!(
            self.state().serves(claim),
            "slot is not awake for this owner and epoch"
        );
        self.transition(SlotState::Saving {
            claim: claim.clone(),
        })
        .await?;
        let generation = self.journal.next_generation;
        match self.save_vm().await {
            Ok(snapshot) => {
                self.transition(SlotState::Sleeping {
                    claim: claim.clone(),
                    snapshot,
                })
                .await
            }
            Err(error) => {
                // Only the still-live VM can recover. An older snapshot has stale disk state.
                let recovered = match &mut self.vm {
                    Some(vm) => {
                        vm.running()?
                            && vm.resume().await.is_ok()
                            && vmm::guest_command(
                                &self.config.vsock(),
                                &serde_json::json!({
                                    "action": "resume", "claim": claim,
                                    "unixTimeNanos": chrono::Utc::now().timestamp_nanos_opt()
                                }),
                            )
                            .await
                            .is_ok()
                    }
                    _ => false,
                };
                if recovered {
                    self.transition(SlotState::Awake {
                        claim: claim.clone(),
                    })
                    .await?;
                } else {
                    self.fail(&error).await;
                }
                if matches!(
                    self.state(),
                    SlotState::Awake { .. } | SlotState::Failed { .. }
                ) && let Err(cleanup_error) =
                    fs::remove_dir_all(self.config.snapshot_dir(generation)).await
                    && cleanup_error.kind() != std::io::ErrorKind::NotFound
                {
                    tracing::error!(error = %cleanup_error, "failed snapshot generation cleanup failed");
                }
                Err(error)
            }
        }
    }

    async fn save_vm(&mut self) -> anyhow::Result<Snapshot> {
        vmm::guest_command(
            &self.config.vsock(),
            &serde_json::json!({"action": "freeze"}),
        )
        .await?;
        let generation = self.journal.next_generation;
        self.journal.next_generation = generation
            .checked_add(1)
            .context("snapshot generation exhausted")?;
        self.persist().await?;
        let directory = self.config.snapshot_dir(generation);
        fs::create_dir(&directory).await?;
        let vm = self.vm.as_mut().context("missing VMM during sleep")?;
        vm.save(&directory).await?;
        let disks = [
            self.config.root_disk.clone(),
            self.config.home_disk.clone(),
            directory.join("state.bin"),
            directory.join("memory.bin"),
        ];
        let sync_directory = directory.clone();
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            for disk in &disks {
                std::fs::File::open(disk)?
                    .sync_all()
                    .with_context(|| format!("flush backing file {}", disk.display()))?;
            }
            std::fs::File::open(sync_directory)?.sync_all()?;
            Ok(())
        })
        .await??;
        // Reap before evicting: Firecracker maps the restored memory file privately.
        vm.stop().await?;
        self.vm = None;
        let memory = directory.join("memory.bin");
        tokio::task::spawn_blocking(move || vmm::evict_memory(&memory)).await??;
        self.remove_old_snapshots(generation).await?;
        Ok(Snapshot { generation })
    }

    async fn remove_old_snapshots(&self, keep: u64) -> anyhow::Result<()> {
        let mut entries = fs::read_dir(&self.config.directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            if let Some(generation) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.strip_prefix("snapshot-"))
                .and_then(|s| s.parse::<u64>().ok())
                && generation != keep
            {
                fs::remove_dir_all(entry.path()).await?;
            }
        }
        Ok(())
    }

    async fn fail(&mut self, error: &anyhow::Error) {
        let claim = self.state().claim().cloned();
        if let Some(vm) = &mut self.vm
            && let Err(stop_error) = vm.stop().await
        {
            tracing::error!(error = %stop_error, "cannot prove VMM termination; claim retained");
            let fenced = match claim {
                Some(claim) => SlotState::Stopping { claim },
                None => SlotState::Preparing,
            };
            if let Err(write_error) = self.transition(fenced).await {
                tracing::error!(error = %write_error, "cannot persist VMM fencing; claim retained");
            }
            return;
        }
        self.vm = None;
        if let Err(write_error) = self
            .transition(SlotState::Failed {
                claim,
                message: error.to_string(),
            })
            .await
        {
            tracing::error!(error = %write_error, "cannot persist failed slot; claim retained");
        }
    }

    pub async fn stop(&mut self, claim: &Claim) -> anyhow::Result<()> {
        claim.validate()?;
        ensure!(
            self.state().claim() == Some(claim)
                || matches!(
                    self.state(),
                    SlotState::Vacant { .. } | SlotState::Failed { claim: None, .. }
                ),
            "slot owner or epoch changed"
        );
        // A stopped slot is never reused by another owner.
        self.transition(SlotState::Stopping {
            claim: claim.clone(),
        })
        .await?;
        if let Some(vm) = &mut self.vm {
            vm.stop().await?;
        }
        self.vm = None;
        self.transition(SlotState::Stopped {
            claim: claim.clone(),
        })
        .await
    }
}

fn durable_replace(path: &std::path::Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let temporary = path.with_extension("next");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&temporary, path)?;
    std::fs::File::open(path.parent().context("journal has no directory")?)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SlotConfig {
        let directory =
            std::env::temp_dir().join(format!("tengri-journal-{}", uuid::Uuid::new_v4()));
        SlotConfig {
            identity: SlotIdentity {
                pod_uid: "pod-uid".into(),
                pvc_uid: "pvc-uid".into(),
                image: "guest-image".into(),
                kernel_sha256: "kernel".into(),
                firecracker_version: FIRECRACKER_VERSION.into(),
                cpu: "cpu".into(),
            },
            sockets: directory.join("sockets"),
            root_disk: directory.join("root.ext4"),
            home_disk: directory.join("home.ext4"),
            directory,
            firecracker: "/not-started".into(),
            kernel: "/not-started".into(),
            tap: "tengri0".into(),
            memory_mib: 8192,
            vcpus: 4,
        }
    }

    #[tokio::test]
    async fn restart_accepts_only_committed_state_and_unchanged_disks() {
        let config = config();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        let owner = claim("owner-a", 1);
        slot.transition(SlotState::Sleeping {
            claim: owner.clone(),
            snapshot: Snapshot { generation: 1 },
        })
        .await
        .unwrap();
        drop(slot);
        let mut slot = Slot::open(config.clone()).await.unwrap();
        assert_eq!(slot.state().claim(), Some(&owner));
        let mut changed = config.clone();
        changed.identity.pvc_uid = "replacement-pvc".into();
        assert!(Slot::open(changed).await.is_err());
        slot.transition(SlotState::Restoring {
            claim: owner.clone(),
            generation: 1,
        })
        .await
        .unwrap();
        drop(slot);
        assert!(Slot::open(config.clone()).await.is_err());
        fs::remove_dir_all(config.directory).await.unwrap();
    }

    #[tokio::test]
    async fn failed_restore_keeps_the_owner_and_consumes_the_snapshot() {
        let config = config();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        let owner = claim("owner-a", 1);
        slot.transition(SlotState::Vacant {
            snapshot: Snapshot { generation: 1 },
        })
        .await
        .unwrap();
        assert!(slot.restore(owner.clone()).await.is_err());
        assert!(matches!(slot.state(), SlotState::Failed { claim: Some(c), .. } if c == &owner));
        drop(slot);
        let mut slot = Slot::open(config.clone()).await.unwrap();
        assert!(slot.restore(owner.clone()).await.is_err());
        assert!(slot.stop(&claim("owner-b", 1)).await.is_err());
        slot.stop(&owner).await.unwrap();
        slot.stop(&owner).await.unwrap();
        fs::remove_dir_all(config.directory).await.unwrap();
    }

    #[tokio::test]
    async fn durability_failure_still_fences_traffic() {
        let config = config();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        let owner = claim("owner-a", 1);
        slot.transition(SlotState::Awake {
            claim: owner.clone(),
        })
        .await
        .unwrap();
        let updates = slot.subscribe();
        fs::create_dir(config.directory.join("journal.next"))
            .await
            .unwrap();
        assert!(
            slot.transition(SlotState::Saving {
                claim: owner.clone()
            })
            .await
            .is_err()
        );
        assert!(!updates.borrow().serves(&owner));
        drop(slot);
        assert!(Slot::open(config.clone()).await.is_err());
        fs::remove_dir_all(config.directory).await.unwrap();
    }

    #[tokio::test]
    async fn lost_vmm_fences_the_owner_and_cannot_restore_old_memory() {
        let config = config();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        let owner = claim("owner-a", 1);
        slot.transition(SlotState::Awake {
            claim: owner.clone(),
        })
        .await
        .unwrap();
        let updates = slot.subscribe();
        slot.refresh_liveness().await;
        assert!(!updates.borrow().serves(&owner));
        assert!(
            matches!(slot.state(), SlotState::Failed { claim: Some(claim), .. } if claim == &owner)
        );
        assert!(slot.restore(owner.clone()).await.is_err());
        fs::remove_dir_all(config.directory).await.unwrap();
    }

    fn claim(uid: &str, epoch: u64) -> Claim {
        Claim {
            microvm_id: "agent-test".into(),
            microvm_uid: uid.into(),
            epoch,
        }
    }

    #[test]
    fn restore_never_reuses_consumed_or_other_owner_state() {
        let owner = claim("owner-a", 1);
        let sleeping = SlotState::Sleeping {
            claim: owner.clone(),
            snapshot: Snapshot { generation: 2 },
        };
        assert!(sleeping.restore_snapshot(&owner).is_ok());
        assert!(sleeping.restore_snapshot(&claim("owner-b", 1)).is_err());
        assert!(sleeping.restore_snapshot(&claim("owner-a", 2)).is_err());
        for state in [
            SlotState::Restoring {
                claim: owner.clone(),
                generation: 2,
            },
            SlotState::Awake {
                claim: owner.clone(),
            },
            SlotState::Saving {
                claim: owner.clone(),
            },
            SlotState::Failed {
                claim: Some(owner.clone()),
                message: "disk write advanced".into(),
            },
        ] {
            assert!(
                state.restore_snapshot(&owner).is_err(),
                "consumed snapshot accepted in {state:?}"
            );
        }
        assert!(
            SlotState::Vacant {
                snapshot: Snapshot { generation: 1 }
            }
            .restore_snapshot(&claim("owner-a", 0))
            .is_err()
        );
    }
}
