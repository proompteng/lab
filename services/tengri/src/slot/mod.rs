mod admission;
pub(crate) use admission::REPLAY_STARTUP_FENCE_MS;
pub mod client;
#[cfg(all(test, target_os = "linux"))]
mod kvm_test;
#[cfg(test)]
mod probe_output;
pub mod runner;
pub mod supervisor;
mod vmm;

use std::{path::PathBuf, time::Duration};

use anyhow::{Context, bail, ensure};
use serde::{Deserialize, Serialize};
use tokio::{
    fs,
    sync::{Mutex, watch},
    task::JoinHandle,
};
use vmm::Vmm;

pub const FIRECRACKER_VERSION: &str = "1.16.1+tengri-async-io.8";
pub const GUEST_API_PORT: u32 = 1024;
pub const GUEST_CONTROL_PORT: u32 = 1025;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Allocation {
    pub microvm_id: String,
    pub microvm_uid: String,
    pub epoch: u64,
}

impl Allocation {
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
pub struct Claim {
    pub microvm_id: String,
    pub microvm_uid: String,
    pub epoch: u64,
    pub runtime_epoch: String,
}

impl Claim {
    pub fn allocation(&self) -> Allocation {
        Allocation {
            microvm_id: self.microvm_id.clone(),
            microvm_uid: self.microvm_uid.clone(),
            epoch: self.epoch,
        }
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        self.allocation().validate()?;
        ensure!(
            crate::ofz::canonical_uuid(&self.runtime_epoch),
            "invalid runtime epoch"
        );
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
            } if owner.allocation() == claim.allocation() => Ok(snapshot),
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

#[derive(Clone, Debug, PartialEq, Eq)]
enum SleepCommit {
    Saved(Snapshot),
    Recovered,
}

pub struct Slot {
    config: SlotConfig,
    journal: Journal,
    vm: Option<Vmm>,
    pending_sleep: Option<SleepCommit>,
    journal_write: Mutex<Option<JoinHandle<anyhow::Result<()>>>>,
    #[cfg(test)]
    evict_snapshot: fn(&std::path::Path) -> anyhow::Result<()>,
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
                let mut journal: Journal =
                    serde_json::from_slice(&bytes).context("read slot journal")?;
                ensure!(
                    journal.identity == config.identity,
                    "snapshot identity changed; retain the claim and require explicit fenced recovery"
                );
                ensure!(journal.next_generation > 0, "invalid snapshot generation");
                if matches!(journal.state, SlotState::Preparing) {
                    journal.state = SlotState::Failed {
                        claim: None,
                        message: "runner restarted during slot preparation".into(),
                    };
                }
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
            pending_sleep: None,
            journal_write: Mutex::new(None),
            #[cfg(test)]
            evict_snapshot: vmm::evict_memory,
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
        let mut pending = self.journal_write.lock().await;
        // A cancelled lifecycle cannot let its detached fsync overwrite the fencing journal.
        if let Err(error) = finish_journal_write(&mut pending).await {
            tracing::error!(error = %error, "interrupted journal write failed");
        }
        *pending = Some(tokio::task::spawn_blocking(move || {
            durable_replace(&path, &bytes)
        }));
        finish_journal_write(&mut pending).await
    }

    #[tracing::instrument(name = "journal.persist", skip_all)]
    async fn transition(&mut self, state: SlotState) -> anyhow::Result<()> {
        let completed = matches!(
            state,
            SlotState::Vacant { .. }
                | SlotState::Awake { .. }
                | SlotState::Sleeping { .. }
                | SlotState::Stopped { .. }
        );
        let previous = std::mem::replace(&mut self.journal.state, state);
        if !completed {
            // Fence traffic even when the durability write fails.
            self.state_tx.send_replace(self.journal.state.clone());
        }
        if let Err(error) = self.persist().await {
            if completed {
                self.journal.state = previous;
            }
            return Err(error);
        }
        self.state_tx.send_replace(self.journal.state.clone());
        Ok(())
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
        if !fs::try_exists(&self.config.root_disk).await? {
            runner::stage_root_disk(
                &self.config,
                std::path::Path::new("/guest/rootfs.ext4"),
                std::path::Path::new("/run/guest-bootstrap/token"),
                std::env::var("TENGRI_INITIALIZE_HOME")
                    .context("TENGRI_INITIALIZE_HOME is required")?
                    == "true",
            )
            .await?;
        }
        self.vm = Some(Vmm::spawn(&self.config).await?);
        self.vm
            .as_mut()
            .context("missing VMM during boot")?
            .boot(&self.config)
            .await?;
        self.vm
            .as_mut()
            .context("missing VMM during preparation")?
            .wait_guest(&self.config.vsock(), Duration::from_secs(35 * 60))
            .await?;
        let snapshot = self.save_vm().await?;
        self.finish_snapshot(snapshot.generation).await?;
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

    #[tracing::instrument(name = "guest.restore", skip_all)]
    async fn restore_vm(&mut self, snapshot: &Snapshot, claim: &Claim) -> anyhow::Result<()> {
        #[cfg(test)]
        let started = std::time::Instant::now();
        self.vm = Some(Vmm::spawn(&self.config).await?);
        self.vm
            .as_mut()
            .context("missing VMM during load")?
            .load(&self.config, &self.config.snapshot_dir(snapshot.generation))
            .await?;
        #[cfg(test)]
        eprintln!(
            "real KVM runner loaded: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        self.vm
            .as_ref()
            .context("missing restored VMM")?
            .resume()
            .await?;
        #[cfg(test)]
        eprintln!(
            "real KVM runner resumed: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        let reply = vmm::guest_command(
            &self.config.vsock(),
            &serde_json::json!({
                "action": "resume", "claim": claim
            }),
        )
        .await?;
        ensure!(
            reply.get("claim") == Some(&serde_json::to_value(claim)?),
            "restored guest claim does not match its slot"
        );
        #[cfg(test)]
        eprintln!(
            "real KVM runner guest ready: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        self.transition(SlotState::Awake {
            claim: claim.clone(),
        })
        .await?;
        #[cfg(test)]
        eprintln!(
            "real KVM runner journal committed: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        Ok(())
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
        if matches!(self.state(), SlotState::Saving { claim: owner } if owner == claim) {
            let outcome = self
                .pending_sleep
                .clone()
                .context("sleep has no completed outcome to commit")?;
            self.commit_sleep(claim, outcome.clone()).await?;
            if outcome == SleepCommit::Recovered {
                bail!("previous snapshot save failed; guest recovered, retry sleep");
            }
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
            Ok(snapshot) => self.commit_sleep(claim, SleepCommit::Saved(snapshot)).await,
            Err(error) => {
                // Only the still-live VM can recover. An older snapshot has stale disk state.
                let recovered = match &mut self.vm {
                    Some(vm) => {
                        vm.running()?
                            && vm.resume().await.is_ok()
                            && vmm::guest_command(
                                &self.config.vsock(),
                                &serde_json::json!({
                                    "action": "resume", "claim": claim
                                }),
                            )
                            .await
                            .is_ok()
                    }
                    _ => false,
                };
                if recovered {
                    self.commit_sleep(claim, SleepCommit::Recovered).await?;
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

    async fn commit_sleep(&mut self, claim: &Claim, outcome: SleepCommit) -> anyhow::Result<()> {
        ensure!(
            matches!(self.state(), SlotState::Saving { claim: owner } if owner == claim),
            "sleep commit requires the same owner and epoch"
        );
        self.pending_sleep = Some(outcome.clone());
        let completed = match outcome {
            SleepCommit::Saved(snapshot) => {
                ensure!(self.vm.is_none(), "completed save requires a stopped VMM");
                self.finish_snapshot(snapshot.generation).await?;
                SlotState::Sleeping {
                    claim: claim.clone(),
                    snapshot,
                }
            }
            SleepCommit::Recovered => {
                ensure!(
                    self.vm
                        .as_mut()
                        .context("recovered VMM is missing")?
                        .running()?,
                    "recovered VMM has exited"
                );
                SlotState::Awake {
                    claim: claim.clone(),
                }
            }
        };
        self.transition(completed).await?;
        self.pending_sleep = None;
        Ok(())
    }

    #[tracing::instrument(name = "guest.snapshot.save", skip_all)]
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
        Ok(Snapshot { generation })
    }

    #[tracing::instrument(name = "guest.snapshot.finalize", skip_all)]
    async fn finish_snapshot(&self, generation: u64) -> anyhow::Result<()> {
        let memory = self.config.snapshot_dir(generation).join("memory.bin");
        #[cfg(not(test))]
        let evict = vmm::evict_memory;
        #[cfg(test)]
        let evict = self.evict_snapshot;
        tokio::task::spawn_blocking(move || evict(&memory)).await??;
        self.remove_old_snapshots(generation).await
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

    async fn fence_execution(&mut self, claim: &Claim) -> anyhow::Result<()> {
        claim.validate()?;
        if self.vm.is_none()
            && matches!(
                self.state(),
                SlotState::Vacant { .. } | SlotState::Failed { claim: None, .. }
            )
        {
            return self.persist().await;
        }
        ensure!(
            self.state().claim() == Some(claim),
            "slot fencing owner or epoch changed"
        );
        self.fail(&anyhow::anyhow!("slot lifecycle authority withdrawn"))
            .await;
        ensure!(self.vm.is_none(), "cannot prove VMM termination");
        self.pending_sleep = None;
        self.persist().await
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
        .await?;
        self.pending_sleep = None;
        Ok(())
    }
}

async fn finish_journal_write(
    pending: &mut Option<JoinHandle<anyhow::Result<()>>>,
) -> anyhow::Result<()> {
    if let Some(task) = pending.as_mut() {
        let result = task.await;
        pending.take();
        result.context("journal writer stopped")??;
    }
    Ok(())
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

    #[tokio::test]
    async fn disconnected_lifecycle_kills_vmm_and_retains_home_and_claim() {
        use std::sync::Arc;
        use tokio::{
            io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
            net::{UnixListener, UnixStream},
            sync::Notify,
            time::timeout,
        };
        let mut config = config();
        config.sockets =
            PathBuf::from("/tmp").join(format!("tengri-cancel-{}", uuid::Uuid::new_v4()));
        let mut slot = Slot::open(config.clone()).await.unwrap();
        let owner = claim("owner-a", 1);
        slot.transition(SlotState::Awake {
            claim: owner.clone(),
        })
        .await
        .unwrap();
        fs::write(&config.home_disk, b"retained home history and drafts")
            .await
            .unwrap();
        slot.vm = Some(Vmm::from_child(
            tokio::process::Command::new("cat")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap(),
        ));
        let state = slot.subscribe();
        let frozen = Arc::new(Notify::new());
        let listener = UnixListener::bind(config.vsock()).unwrap();
        let guest = tokio::spawn({
            let frozen = frozen.clone();
            async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                stream.read_line(&mut line).await.unwrap();
                assert_eq!(line, "CONNECT 1025\n");
                stream.get_mut().write_all(b"OK 1025\n").await.unwrap();
                line.clear();
                stream.read_line(&mut line).await.unwrap();
                let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["action"], "freeze");
                frozen.notify_one();
                std::future::pending::<()>().await;
            }
        });
        let slot = Arc::new(Mutex::new(slot));
        let (server, client) = UnixStream::pair().unwrap();
        let serving = tokio::spawn(runner::serve_connection(
            server,
            slot.clone(),
            state,
            config.identity.clone(),
        ));
        let (reader, mut writer) = client.into_split();
        let mut bytes = serde_json::to_vec(&runner::CommandRequest::Sleep {
            claim: owner.clone(),
        })
        .unwrap();
        bytes.push(b'\n');
        writer.write_all(&bytes).await.unwrap();
        timeout(Duration::from_secs(30), frozen.notified())
            .await
            .expect("guest fixture must reach freeze before testing cancellation");
        writer.shutdown().await.unwrap();
        let mut response = String::new();
        timeout(
            Duration::from_secs(2),
            BufReader::new(reader).read_line(&mut response),
        )
        .await
        .unwrap()
        .unwrap();
        let response: runner::CommandResponse = serde_json::from_str(&response).unwrap();
        assert!(response.error.unwrap().contains("caller disconnected"));
        assert!(
            matches!(response.status.state, SlotState::Failed { claim: Some(ref claim), .. } if claim == &owner)
        );
        let slot = slot.lock().await;
        assert!(
            slot.vm.is_none(),
            "the VMM must be terminated and reaped before acknowledgement"
        );
        assert_eq!(
            fs::read(&config.home_disk).await.unwrap(),
            b"retained home history and drafts"
        );
        let reopened = Slot::open(config.clone()).await.unwrap();
        assert_eq!(reopened.state().claim(), Some(&owner));
        assert!(reopened.state().restore_snapshot(&owner).is_err());
        drop(slot);
        serving.await.unwrap();
        guest.abort();
        let _ = guest.await;
        fs::remove_dir_all(config.directory).await.unwrap();
        fs::remove_dir_all(config.sockets).await.unwrap();
    }

    #[tokio::test]
    async fn execution_fence_rejects_foreign_claim_and_stops_completed_restore() {
        let config = config();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        let owner = claim("owner-a", 1);
        slot.transition(SlotState::Awake {
            claim: owner.clone(),
        })
        .await
        .unwrap();
        slot.vm = Some(Vmm::from_child(
            tokio::process::Command::new("cat")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap(),
        ));
        assert!(slot.fence_execution(&claim("owner-b", 1)).await.is_err());
        assert!(slot.vm.as_mut().unwrap().running().unwrap());
        assert!(slot.state().serves(&owner));
        slot.fence_execution(&owner).await.unwrap();
        assert!(slot.vm.is_none());
        assert!(
            matches!(slot.state(), SlotState::Failed { claim: Some(claim), .. } if claim == &owner)
        );
        fs::remove_dir_all(config.directory).await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_journal_write_cannot_overwrite_execution_fence() {
        let config = config();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        let owner = claim("owner-a", 1);
        slot.transition(SlotState::Awake {
            claim: owner.clone(),
        })
        .await
        .unwrap();
        let old_bytes = serde_json::to_vec(&slot.journal).unwrap();
        let path = config.directory.join("journal.json");
        let (release, wait) = std::sync::mpsc::channel();
        let write_path = path.clone();
        *slot.journal_write.lock().await = Some(tokio::task::spawn_blocking(move || {
            wait.recv().unwrap();
            durable_replace(&write_path, &old_bytes)
        }));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), slot.persist())
                .await
                .is_err()
        );
        let fence = slot.fence_execution(&owner);
        tokio::pin!(fence);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut fence)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        fence.await.unwrap();
        let journal: Journal = serde_json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
        assert!(
            matches!(journal.state, SlotState::Failed { claim: Some(ref claim), .. } if claim == &owner)
        );
        fs::remove_dir_all(config.directory).await.unwrap();
    }

    #[tokio::test]
    async fn restore_cancellation_retains_the_vmm_handle_until_fenced_and_reaped() {
        use std::os::unix::fs::PermissionsExt;
        let mut config = config();
        fs::create_dir_all(&config.directory).await.unwrap();
        config.firecracker = config.directory.join("fake-vmm.sh");
        // The VMM clears its environment; Nix shells cannot resolve bare sleep without PATH.
        let sleep = std::process::Command::new("sh")
            .args(["-c", "command -v sleep"])
            .output()
            .unwrap();
        assert!(
            sleep.status.success(),
            "sleep fixture dependency is missing"
        );
        let sleep = String::from_utf8(sleep.stdout).unwrap();
        let sleep = sleep.trim().replace('\'', "'\"'\"'");
        fs::write(
            &config.firecracker,
            format!("#!/bin/sh\nprintf started > \"$0.started\"\nexec '{sleep}' 60\n"),
        )
        .await
        .unwrap();
        fs::set_permissions(&config.firecracker, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        let snapshot = config.snapshot_dir(1);
        fs::create_dir(&snapshot).await.unwrap();
        std::fs::File::create(snapshot.join("memory.bin"))
            .unwrap()
            .set_len(8192 << 20)
            .unwrap();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        slot.transition(SlotState::Vacant {
            snapshot: Snapshot { generation: 1 },
        })
        .await
        .unwrap();
        let owner = claim("owner-a", 1);
        {
            let restore = slot.restore(owner.clone());
            tokio::pin!(restore);
            let started = async {
                while !fs::try_exists(config.directory.join("fake-vmm.sh.started"))
                    .await
                    .unwrap()
                {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            };
            tokio::select! {
                result = &mut restore => panic!("restore unexpectedly completed: {result:?}"),
                result = tokio::time::timeout(Duration::from_secs(30), started) => result.expect("VMM fixture must start before testing cancellation"),
            }
        }
        assert!(
            slot.vm.is_some(),
            "cancelling API startup must retain the child for termination proof"
        );
        assert!(slot.vm.as_mut().unwrap().running().unwrap());
        slot.fence_execution(&owner).await.unwrap();
        assert!(slot.vm.is_none());
        assert!(
            matches!(slot.state(), SlotState::Failed { claim: Some(claim), .. } if claim == &owner)
        );
        fs::remove_dir_all(config.directory).await.unwrap();
    }

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
    async fn previous_firecracker_revision_cannot_restore_an_owned_snapshot() {
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
        let path = config.directory.join("journal.json");
        let mut journal: Journal = serde_json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
        journal.identity.firecracker_version = "1.16.1".into();
        let previous = serde_json::to_vec(&journal).unwrap();
        fs::write(&path, &previous).await.unwrap();
        let Err(error) = Slot::open(config.clone()).await else {
            panic!("restored a snapshot from another Firecracker revision");
        };
        assert!(error.to_string().contains("snapshot identity changed"));
        assert_eq!(fs::read(&path).await.unwrap(), previous);
        assert_eq!(journal.state.claim(), Some(&owner));
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
    async fn failed_sleep_commit_is_not_published_and_can_be_retried() {
        let config = config();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        slot.evict_snapshot = |_| Ok(());
        let owner = claim("owner-a", 1);
        let saving = SlotState::Saving {
            claim: owner.clone(),
        };
        slot.transition(saving.clone()).await.unwrap();
        let updates = slot.subscribe();
        fs::create_dir(config.directory.join("journal.next"))
            .await
            .unwrap();
        let sleeping = SlotState::Sleeping {
            claim: owner.clone(),
            snapshot: Snapshot { generation: 1 },
        };
        assert!(
            slot.commit_sleep(&owner, SleepCommit::Saved(Snapshot { generation: 1 }))
                .await
                .is_err()
        );
        assert_eq!(slot.state(), &saving);
        assert_eq!(*updates.borrow(), saving);
        let journal: Journal = serde_json::from_slice(
            &fs::read(config.directory.join("journal.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(journal.state, saving);
        assert!(slot.sleep(&claim("owner-b", 1)).await.is_err());
        assert!(slot.sleep(&claim("owner-a", 2)).await.is_err());
        assert!(slot.sleep(&owner).await.is_err());
        fs::remove_dir(config.directory.join("journal.next"))
            .await
            .unwrap();
        slot.sleep(&owner).await.unwrap();
        assert_eq!(*updates.borrow(), sleeping);
        assert!(slot.pending_sleep.is_none());
        drop(slot);
        assert_eq!(Slot::open(config.clone()).await.unwrap().state(), &sleeping);
        fs::remove_dir_all(config.directory).await.unwrap();
    }

    #[tokio::test]
    async fn obsolete_snapshot_cleanup_cannot_discard_completed_sleep() {
        let config = config();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        slot.evict_snapshot = |_| Ok(());
        let owner = claim("owner-a", 1);
        let saving = SlotState::Saving {
            claim: owner.clone(),
        };
        slot.transition(saving.clone()).await.unwrap();
        fs::write(config.snapshot_dir(0), b"cleanup fault")
            .await
            .unwrap();
        fs::create_dir(config.snapshot_dir(1)).await.unwrap();
        fs::write(
            config.snapshot_dir(1).join("state.bin"),
            b"completed snapshot",
        )
        .await
        .unwrap();
        assert!(
            slot.commit_sleep(&owner, SleepCommit::Saved(Snapshot { generation: 1 }))
                .await
                .is_err()
        );
        assert_eq!(slot.state(), &saving);
        assert_eq!(
            slot.pending_sleep,
            Some(SleepCommit::Saved(Snapshot { generation: 1 }))
        );
        assert!(slot.sleep(&owner).await.is_err());
        assert!(slot.sleep(&claim("owner-b", 1)).await.is_err());
        assert!(slot.sleep(&claim("owner-a", 2)).await.is_err());
        assert_eq!(
            fs::read(config.snapshot_dir(1).join("state.bin"))
                .await
                .unwrap(),
            b"completed snapshot"
        );
        fs::remove_file(config.snapshot_dir(0)).await.unwrap();
        fs::create_dir(config.snapshot_dir(0)).await.unwrap();
        slot.sleep(&owner).await.unwrap();
        let sleeping = SlotState::Sleeping {
            claim: owner,
            snapshot: Snapshot { generation: 1 },
        };
        assert_eq!(slot.state(), &sleeping);
        assert!(!fs::try_exists(config.snapshot_dir(0)).await.unwrap());
        assert!(
            fs::try_exists(config.snapshot_dir(1).join("state.bin"))
                .await
                .unwrap()
        );
        assert!(slot.pending_sleep.is_none());
        drop(slot);
        assert_eq!(Slot::open(config.clone()).await.unwrap().state(), &sleeping);
        fs::remove_dir_all(config.directory).await.unwrap();
    }

    #[tokio::test]
    async fn snapshot_eviction_failure_keeps_the_completed_generation_retryable() {
        let config = config();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        let owner = claim("owner-a", 1);
        let saving = SlotState::Saving {
            claim: owner.clone(),
        };
        slot.transition(saving.clone()).await.unwrap();
        slot.evict_snapshot = |_| bail!("snapshot pages remain resident");
        fs::create_dir(config.snapshot_dir(1)).await.unwrap();
        fs::write(
            config.snapshot_dir(1).join("memory.bin"),
            b"saved guest memory",
        )
        .await
        .unwrap();
        let updates = slot.subscribe();
        assert!(
            slot.commit_sleep(&owner, SleepCommit::Saved(Snapshot { generation: 1 }))
                .await
                .is_err()
        );
        assert_eq!(*updates.borrow(), saving);
        assert_eq!(
            slot.pending_sleep,
            Some(SleepCommit::Saved(Snapshot { generation: 1 }))
        );
        assert!(slot.sleep(&owner).await.is_err());
        assert!(slot.sleep(&claim("owner-b", 1)).await.is_err());
        assert!(slot.sleep(&claim("owner-a", 2)).await.is_err());
        assert_eq!(
            fs::read(config.snapshot_dir(1).join("memory.bin"))
                .await
                .unwrap(),
            b"saved guest memory"
        );
        slot.evict_snapshot = |_| Ok(());
        slot.sleep(&owner).await.unwrap();
        let sleeping = SlotState::Sleeping {
            claim: owner,
            snapshot: Snapshot { generation: 1 },
        };
        assert_eq!(*updates.borrow(), sleeping);
        assert!(slot.pending_sleep.is_none());
        assert!(slot.vm.is_none());
        drop(slot);
        assert_eq!(Slot::open(config.clone()).await.unwrap().state(), &sleeping);
        fs::remove_dir_all(config.directory).await.unwrap();
    }

    #[tokio::test]
    async fn failed_root_staging_remains_visible_and_retireable() {
        let config = config();
        let source = config.directory.with_extension("root-template");
        fs::write(&source, b"root template").await.unwrap();
        let token = config.directory.join("missing-token");
        assert!(
            runner::stage_root_disk(&config, &source, &token, true)
                .await
                .is_err()
        );
        assert!(!fs::try_exists(&config.root_disk).await.unwrap());
        let mut slot = Slot::open(config.clone()).await.unwrap();
        let error = runner::stage_root_disk(&config, &source, &token, true)
            .await
            .unwrap_err();
        assert_eq!(fs::read(&config.root_disk).await.unwrap(), b"root template");
        slot.fail(&error).await;
        assert!(matches!(
            slot.state(),
            SlotState::Failed { claim: None, .. }
        ));
        drop(slot);
        let mut slot = Slot::open(config.clone()).await.unwrap();
        assert!(matches!(
            slot.state(),
            SlotState::Failed { claim: None, .. }
        ));
        slot.stop(&claim("retirement-lease", 1)).await.unwrap();
        assert!(matches!(slot.state(), SlotState::Stopped { .. }));
        fs::remove_dir_all(config.directory).await.unwrap();
        fs::remove_file(source).await.unwrap();
    }

    #[tokio::test]
    async fn recovered_sleep_commit_stays_fenced_until_durable_and_retryable() {
        let config = config();
        let mut slot = Slot::open(config.clone()).await.unwrap();
        let owner = claim("owner-a", 1);
        let saving = SlotState::Saving {
            claim: owner.clone(),
        };
        slot.transition(saving.clone()).await.unwrap();
        slot.vm = Some(Vmm::from_child(
            tokio::process::Command::new("cat")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap(),
        ));
        let updates = slot.subscribe();
        fs::create_dir(config.directory.join("journal.next"))
            .await
            .unwrap();
        assert!(
            slot.commit_sleep(&owner, SleepCommit::Recovered)
                .await
                .is_err()
        );
        assert_eq!(*updates.borrow(), saving);
        assert_eq!(slot.pending_sleep, Some(SleepCommit::Recovered));
        assert!(slot.sleep(&claim("owner-b", 1)).await.is_err());
        assert!(slot.sleep(&claim("owner-a", 2)).await.is_err());
        assert!(slot.sleep(&owner).await.is_err());
        assert_eq!(slot.state(), &saving);
        fs::remove_dir(config.directory.join("journal.next"))
            .await
            .unwrap();
        let error = slot.sleep(&owner).await.unwrap_err();
        assert!(error.to_string().contains("guest recovered, retry sleep"));
        assert_eq!(
            *updates.borrow(),
            SlotState::Awake {
                claim: owner.clone()
            }
        );
        assert!(slot.vm.as_mut().unwrap().running().unwrap());
        assert!(slot.pending_sleep.is_none());
        let journal: Journal = serde_json::from_slice(
            &fs::read(config.directory.join("journal.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            journal.state,
            SlotState::Awake {
                claim: owner.clone()
            }
        );
        slot.stop(&owner).await.unwrap();
        fs::remove_dir_all(config.directory).await.unwrap();
    }

    #[tokio::test]
    async fn interrupted_preparation_reopens_as_an_unclaimed_retireable_failure() {
        let config = config();
        let slot = Slot::open(config.clone()).await.unwrap();
        assert_eq!(slot.state(), &SlotState::Preparing);
        drop(slot);
        let mut slot = Slot::open(config.clone()).await.unwrap();
        assert!(matches!(
            slot.state(),
            SlotState::Failed { claim: None, .. }
        ));
        let retirement = claim("retirement-lease", 1);
        slot.stop(&retirement).await.unwrap();
        assert_eq!(slot.state(), &SlotState::Stopped { claim: retirement });
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
            runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
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
        let mut next_runtime = owner.clone();
        next_runtime.runtime_epoch = "55555555-5555-4555-8555-555555555555".into();
        assert!(sleeping.restore_snapshot(&next_runtime).is_ok());
        assert!(
            !SlotState::Awake {
                claim: owner.clone()
            }
            .serves(&next_runtime)
        );
        for invalid in ["", "not-a-runtime", "44444444-4444-4444-8444-44444444444A"] {
            next_runtime.runtime_epoch = invalid.into();
            assert!(sleeping.restore_snapshot(&next_runtime).is_err());
        }
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
