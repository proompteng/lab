use std::{env, os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    process::Command,
    sync::Mutex,
    time::timeout,
};

use super::{Claim, FIRECRACKER_VERSION, Slot, SlotConfig, SlotIdentity, SlotState};

pub(super) const COMMAND_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum CommandRequest {
    Status,
    Restore { claim: Claim },
    Sleep { claim: Claim },
    Stop { claim: Claim },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SlotStatus {
    pub identity: SlotIdentity,
    pub state: SlotState,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandResponse {
    pub status: SlotStatus,
    pub error: Option<String>,
}

pub fn sockets_directory() -> PathBuf {
    PathBuf::from("/run/tengri/slot")
}

pub async fn command(request: &CommandRequest) -> anyhow::Result<SlotStatus> {
    let stream = UnixStream::connect(sockets_directory().join("control.sock")).await?;
    timeout(COMMAND_TIMEOUT, async {
        let (reader, mut writer) = stream.into_split();
        let mut bytes = serde_json::to_vec(request)?;
        bytes.push(b'\n');
        writer.write_all(&bytes).await?;
        let mut reader = BufReader::new(reader).take(16385);
        let mut response = String::new();
        reader.read_line(&mut response).await?;
        ensure!(
            response.len() <= 16384 && response.ends_with('\n'),
            "invalid runner response"
        );
        let response: CommandResponse = serde_json::from_str(&response)?;
        ensure!(
            response.error.is_none(),
            "slot lifecycle: {}",
            response.error.unwrap_or_default()
        );
        Ok(response.status)
    })
    .await
    .context("slot lifecycle timed out")?
}

pub async fn run() -> anyhow::Result<()> {
    prepare_private_home_device()?;
    let config = configuration().await?;
    serve(config).await
}

pub(super) async fn serve(config: SlotConfig) -> anyhow::Result<()> {
    let identity = config.identity.clone();
    let slot = Slot::open(config.clone()).await?;
    let state = slot.subscribe();
    let slot = Arc::new(Mutex::new(slot));
    let socket = config.sockets.join("control.sock");
    if fs::try_exists(&socket).await? {
        fs::remove_file(&socket).await?;
    }
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).await?;
    let preparation = slot.clone();
    tokio::spawn(async move {
        let mut slot = preparation.lock().await;
        if matches!(slot.state(), SlotState::Preparing)
            && let Err(error) = slot.prepare().await
        {
            tracing::error!(error = %error, "slot preparation failed");
        }
    });
    let mut health = tokio::time::interval(Duration::from_secs(1));
    loop {
        let (stream, _) = tokio::select! {
            accepted = listener.accept() => accepted?,
            _ = health.tick() => {
                if let Ok(mut slot) = slot.try_lock() {
                    slot.refresh_liveness().await;
                }
                continue;
            }
        };
        let slot = slot.clone();
        let state = state.clone();
        let identity = identity.clone();
        tokio::spawn(async move {
            let (reader, mut writer) = stream.into_split();
            let mut line = String::new();
            let read = timeout(
                Duration::from_secs(5),
                BufReader::new(reader).take(4097).read_line(&mut line),
            )
            .await;
            if !matches!(read, Ok(Ok(_))) || line.len() > 4096 || !line.ends_with('\n') {
                return;
            }
            let request = match serde_json::from_str::<CommandRequest>(&line) {
                Ok(request) => request,
                Err(_) => return,
            };
            let error = match request {
                CommandRequest::Status => {
                    if let Ok(mut slot) = slot.try_lock() {
                        slot.refresh_liveness().await;
                    }
                    None
                }
                request => match slot.try_lock() {
                    Ok(mut slot) => match request {
                        CommandRequest::Restore { claim } => slot.restore(claim).await.err(),
                        CommandRequest::Sleep { claim } => slot.sleep(&claim).await.err(),
                        CommandRequest::Stop { claim } => slot.stop(&claim).await.err(),
                        CommandRequest::Status => unreachable!(),
                    },
                    Err(_) => {
                        let expected = match &request {
                            CommandRequest::Restore { claim } | CommandRequest::Sleep { claim } => {
                                Some(claim)
                            }
                            _ => None,
                        };
                        let same_operation = matches!((&request, &*state.borrow()),
                            (CommandRequest::Restore { claim }, SlotState::Restoring { claim: owner, .. })
                            | (CommandRequest::Sleep { claim }, SlotState::Saving { claim: owner }) if claim == owner);
                        if same_operation {
                            let mut updates = state.clone();
                            match timeout(
                                COMMAND_TIMEOUT,
                                updates.wait_for(|s| {
                                    !matches!(
                                        s,
                                        SlotState::Restoring { .. } | SlotState::Saving { .. }
                                    )
                                }),
                            )
                            .await
                            {
                                Ok(Ok(done))
                                    if done.claim() == expected
                                        && matches!(
                                            (&request, &*done),
                                            (
                                                CommandRequest::Restore { .. },
                                                SlotState::Awake { .. }
                                            ) | (
                                                CommandRequest::Sleep { .. },
                                                SlotState::Sleeping { .. }
                                            )
                                        ) =>
                                {
                                    None
                                }
                                _ => Some(anyhow::anyhow!(
                                    "concurrent slot lifecycle did not complete"
                                )),
                            }
                        } else {
                            Some(anyhow::anyhow!("slot lifecycle is busy"))
                        }
                    }
                },
            };
            let response = CommandResponse {
                status: SlotStatus {
                    identity,
                    state: state.borrow().clone(),
                },
                error: error.map(|e| e.to_string()),
            };
            if let Ok(mut bytes) = serde_json::to_vec(&response) {
                bytes.push(b'\n');
                let _ = writer.write_all(&bytes).await;
            }
        });
    }
}

async fn configuration() -> anyhow::Result<SlotConfig> {
    let directory = PathBuf::from("/var/lib/tengri/slot");
    let root_disk = directory.join("rootfs.ext4");
    let sockets = sockets_directory();
    fs::create_dir_all(&directory).await?;
    fs::create_dir_all(&sockets).await?;
    fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).await?;
    fs::set_permissions(&sockets, std::fs::Permissions::from_mode(0o700)).await?;
    let kernel = PathBuf::from("/guest/vmlinux");
    let kernel_bytes = fs::read(&kernel).await?;
    let identity = SlotIdentity {
        pod_uid: env::var("TENGRI_POD_UID").context("TENGRI_POD_UID is required")?,
        pvc_uid: env::var("TENGRI_PVC_UID").context("TENGRI_PVC_UID is required")?,
        image: env::var("TENGRI_GUEST_IMAGE").context("TENGRI_GUEST_IMAGE is required")?,
        kernel_sha256: format!("{:x}", Sha256::digest(kernel_bytes)),
        firecracker_version: FIRECRACKER_VERSION.into(),
        cpu: cpu_identity().await?,
    };
    if !fs::try_exists(directory.join("journal.json")).await? {
        ensure!(
            !fs::try_exists(&root_disk).await?,
            "uncommitted root disk exists; require explicit cleanup"
        );
        fs::copy("/guest/rootfs.ext4", &root_disk).await?;
        let token = fs::read_to_string("/run/guest-bootstrap/token").await?;
        let config_file = directory.join("guest-config.json");
        fs::write(&config_file, serde_json::to_vec(&json!({
            "podUid": identity.pod_uid, "token": token,
            "initializeHome": env::var("TENGRI_INITIALIZE_HOME").context("TENGRI_INITIALIZE_HOME is required")? == "true"
        }))?).await?;
        for (source, destination) in [
            (&config_file, "/etc/tengri-slot.json"),
            (&PathBuf::from("/etc/resolv.conf"), "/etc/resolv.conf"),
        ] {
            let output = Command::new("debugfs")
                .args(["-w", "-R"])
                .arg(format!("write {} {destination}", source.display()))
                .arg(&root_disk)
                .output()
                .await?;
            ensure!(
                output.status.success()
                    && !String::from_utf8_lossy(&output.stderr).contains("Could not allocate"),
                "write guest boot configuration failed"
            );
            let readback = Command::new("debugfs")
                .args(["-R"])
                .arg(format!("cat {destination}"))
                .arg(&root_disk)
                .output()
                .await?;
            ensure!(
                readback.status.success() && readback.stdout == fs::read(source).await?,
                "guest boot configuration readback failed"
            );
        }
        let output = Command::new("debugfs")
            .args([
                "-w",
                "-R",
                "set_inode_field /etc/tengri-slot.json mode 0100600",
            ])
            .arg(&root_disk)
            .output()
            .await?;
        ensure!(
            output.status.success(),
            "set private guest configuration mode failed"
        );
        fs::remove_file(config_file).await?;
    }
    Ok(SlotConfig {
        identity,
        directory,
        sockets,
        firecracker: PathBuf::from("/usr/local/bin/firecracker"),
        kernel,
        root_disk,
        home_disk: PathBuf::from("/dev/tengri-private-home"),
        tap: "tengri0".into(),
        memory_mib: 8192,
        vcpus: 4,
    })
}

#[cfg(target_os = "linux")]
fn prepare_private_home_device() -> anyhow::Result<()> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    ensure!(
        unsafe { libc::geteuid() } == 0,
        "runner device setup requires its startup UID"
    );
    let source = std::fs::symlink_metadata("/dev/tengri-home")?;
    ensure!(
        source.file_type().is_block_device(),
        "home is not an allocated raw block device"
    );
    let path = c"/dev/tengri-private-home";
    // Create an inode in this container's /dev. Never chmod the node's RBD inode.
    if unsafe { libc::mknod(path.as_ptr(), libc::S_IFBLK | 0o600, source.rdev()) } != 0 {
        return Err(std::io::Error::last_os_error()).context("create private home device inode");
    }
    std::fs::set_permissions(
        "/dev/tengri-private-home",
        std::fs::Permissions::from_mode(0o666),
    )?;
    let kvm_group = std::fs::metadata("/dev/kvm")?.gid();
    let groups = [65532, kvm_group];
    unsafe {
        if libc::setgroups(groups.len(), groups.as_ptr()) != 0
            || libc::setresgid(65532, 65532, 65532) != 0
            || libc::setresuid(65532, 65532, 65532) != 0
            || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
        {
            return Err(std::io::Error::last_os_error()).context("drop runner startup privileges");
        }
    }
    ensure!(
        unsafe { libc::geteuid() } == 65532,
        "runner UID was not dropped"
    );
    let status = std::fs::read_to_string("/proc/self/status")?;
    for capability in ["CapInh", "CapPrm", "CapEff", "CapAmb"] {
        ensure!(
            status
                .lines()
                .any(|line| line == format!("{capability}:\t0000000000000000")),
            "runner retained {capability}"
        );
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn prepare_private_home_device() -> anyhow::Result<()> {
    anyhow::bail!("runner device setup requires Linux")
}

async fn cpu_identity() -> anyhow::Result<String> {
    let cpu = fs::read_to_string("/proc/cpuinfo").await?;
    let first = cpu
        .split("\n\n")
        .next()
        .context("CPU identity is unavailable")?;
    let stable: String = first
        .lines()
        .filter(|line| {
            [
                "vendor_id",
                "cpu family",
                "model\t",
                "stepping",
                "flags",
                "Features",
                "CPU implementer",
                "CPU architecture",
                "CPU variant",
                "CPU part",
                "CPU revision",
            ]
            .iter()
            .any(|prefix| line.starts_with(prefix))
        })
        .collect::<Vec<_>>()
        .join("\n");
    ensure!(!stable.is_empty(), "CPU identity is unavailable");
    Ok(format!("{:x}", Sha256::digest(stable.as_bytes())))
}
