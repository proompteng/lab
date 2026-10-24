use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, ensure};
use k8s_openapi::api::core::v1::Pod;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{fs, io::AsyncReadExt, net::TcpListener, sync::mpsc};
use tokio_stream::wrappers::ReceiverStream;

use super::{
    Claim, FIRECRACKER_VERSION, SlotConfig, SlotIdentity, SlotState,
    client::SlotClient,
    probe_output::{EDITOR_READY, ProbeOutput, editor_probe_command},
    runner, supervisor,
};
use crate::{
    guest::rpc::{RpcClient, proto},
    identity::WorkloadIdentity,
};

struct Authority(Child);
impl Drop for Authority {
    fn drop(&mut self) {
        drop(self.0.stdin.take());
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires isolated KVM/TAP and real boot artifacts; run test-kvm.sh"]
async fn real_guest_restores_files_codex_and_the_same_shell_without_resident_snapshot_pages()
-> anyhow::Result<()> {
    crate::install_rustls_crypto_provider()?;
    ensure!(
        unsafe { libc::geteuid() } == 65532,
        "fixture must run as the real VMM UID"
    );
    let status = fs::read_to_string("/proc/self/status").await?;
    ensure!(
        status
            .lines()
            .any(|line| line == "CapEff:\t0000000000000000"),
        "fixture retained capabilities"
    );
    let cpu_max = fs::read_to_string("/sys/fs/cgroup/cpu.max").await?;
    let (quota, period) = cpu_max
        .trim()
        .split_once(' ')
        .context("invalid CPU quota")?;
    ensure!(
        quota.parse::<u64>()? * 1000 == period.parse::<u64>()? * u64::from(crate::crd::CPU_MILLIS),
        "native qualification requires the production four-CPU quota"
    );
    let samples: usize = std::env::var("TENGRI_KVM_SAMPLES")
        .context("set the explicit sample count")?
        .parse()?;
    ensure!(
        samples >= 3,
        "lifecycle acceptance requires at least three cycles"
    );
    let mut authority = Authority(
        Command::new(std::env::var("NANOAGENT_RPC_FIXTURE")?)
            .args(["-test.run=^TestKVMWorkloadAPI$"])
            .env("NANOAGENT_KVM_INTEROP", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
    );
    let stdout = authority.0.stdout.take().context("fixture has no stdout")?;
    let endpoint = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::task::spawn_blocking(move || {
            for line in BufReader::new(stdout).lines() {
                let line = line?;
                if let Some(value) = line.strip_prefix("WORKLOAD_ENDPOINT=") {
                    return Ok::<_, anyhow::Error>(value.to_owned());
                }
            }
            anyhow::bail!("Workload API fixture did not start")
        }),
    )
    .await
    .context("Workload API startup timed out")???;
    let identity =
        WorkloadIdentity::from_endpoint(endpoint.clone(), "proompteng.ai".parse()?, "tengri")
            .await?;
    let slot_identity = WorkloadIdentity::from_endpoint_with_id(
        endpoint,
        "proompteng.ai".parse()?,
        "spiffe://proompteng.ai/ns/tengri/slot/pod/33333333-3333-4333-8333-333333333333".parse()?,
    )
    .await?;
    let directory = PathBuf::from("/work/slot");
    fs::create_dir(&directory).await?;
    let root_disk = directory.join("rootfs.ext4");
    fs::copy("/guest/rootfs.ext4", &root_disk).await?;
    let token =
        uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
    let configuration = directory.join("config.json");
    fs::write(
        &configuration,
        serde_json::to_vec(
            &json!({"podUid":"33333333-3333-4333-8333-333333333333", "token":token, "initializeHome":true, "verificationKey":base64::Engine::encode(&base64::engine::general_purpose::STANDARD, tengri::guest_authorization::GuestSigner::from_seed(&std::array::from_fn::<_, 32, _>(|i| i as u8))?.public_key()), "recoveryGeneration":1}),
        )?,
    )
    .await?;
    for (source, destination) in [
        (&configuration, "/etc/tengri-slot.json"),
        (&PathBuf::from("/guest/resolv.conf"), "/etc/resolv.conf"),
    ] {
        let result = tokio::process::Command::new("debugfs")
            .args(["-w", "-R"])
            .arg(format!("write {} {destination}", source.display()))
            .arg(&root_disk)
            .output()
            .await?;
        ensure!(result.status.success(), "inject guest configuration failed");
    }
    let result = tokio::process::Command::new("debugfs")
        .args([
            "-w",
            "-R",
            "set_inode_field /etc/tengri-slot.json mode 0100600",
        ])
        .arg(&root_disk)
        .output()
        .await?;
    ensure!(
        result.status.success(),
        "protect guest configuration failed"
    );
    fs::remove_file(configuration).await?;
    let home_disk = directory.join("home.ext4");
    fs::File::create(&home_disk)
        .await?
        .set_len(u64::from(crate::crd::WORKSPACE_GIB) << 30)
        .await?;
    let kernel = PathBuf::from("/guest/vmlinux");
    let config = SlotConfig {
        identity: SlotIdentity {
            pod_uid: "33333333-3333-4333-8333-333333333333".into(),
            pvc_uid: "private-fixture-home".into(),
            image: std::env::var("TENGRI_GUEST_IMAGE")?,
            kernel_sha256: format!("{:x}", Sha256::digest(fs::read(&kernel).await?)),
            firecracker_version: FIRECRACKER_VERSION.into(),
            cpu: format!("{:x}", Sha256::digest(fs::read("/proc/cpuinfo").await?)),
        },
        directory,
        sockets: runner::sockets_directory(),
        firecracker: "/usr/local/bin/firecracker".into(),
        kernel,
        root_disk,
        home_disk,
        tap: "tengri0".into(),
        memory_mib: 8192,
        vcpus: 4,
    };
    let runner_task = tokio::spawn(runner::serve(config));
    let tls = slot_identity.slot_server_tls("tengri")?;
    let database = std::sync::Arc::new(crate::control::Database::shared_fixture().await);
    let supervisor_database = std::sync::Arc::new(
        crate::control::Database::connect(
            &std::env::var("TENGRI_DATABASE_DSN")?
                .replace("user=tengri_controller", "user=tengri_supervisor"),
            std::path::Path::new(&std::env::var("TENGRI_DATABASE_PASSWORD_FILE")?),
            std::path::Path::new(&std::env::var("TENGRI_DATABASE_CA_FILE")?),
            "tengri_supervisor",
        )
        .await?,
    );
    supervisor_database.verify_schema().await?;
    let fence = database
        .acquire(uuid::Uuid::new_v4())
        .await?
        .context("fixture leadership unavailable")?;
    let renew_database = database.clone();
    let renew_task = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            assert!(
                renew_database.renew(fence).await.unwrap(),
                "fixture leader expired"
            );
        }
    });
    let supervisor_task = tokio::spawn(supervisor::serve(
        TcpListener::bind("127.0.0.1:8443").await?,
        tls,
        supervisor_database,
        super::admission::GuestAdmission::fixture(),
    ));
    let pod: Pod = serde_json::from_value(
        json!({"metadata":{"uid":"33333333-3333-4333-8333-333333333333"},"status":{"podIP":"127.0.0.1"}}),
    )?;
    let client = SlotClient::new(
        &identity,
        "tengri",
        &pod,
        "private-fixture-home",
        &std::env::var("TENGRI_GUEST_IMAGE")?,
    )?;
    let deadline = Instant::now() + Duration::from_secs(35 * 60);
    loop {
        if let Ok(status) = client.status().await {
            match status.state {
                SlotState::Vacant { .. } => break,
                SlotState::Failed { message, .. } => {
                    anyhow::bail!("real guest preparation failed: {message}")
                }
                _ => {}
            }
        }
        ensure!(
            !runner_task.is_finished() && Instant::now() < deadline,
            "real guest preparation stopped or timed out"
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let claim = Claim {
        microvm_id: "fixture-agent".into(),
        microvm_uid: "11111111-1111-4111-8111-111111111111".into(),
        epoch: 1,
        runtime_epoch: "44444444-4444-4444-8444-444444444444".into(),
    };
    eprintln!(
        "real KVM create CPU before:\n{}",
        fs::read_to_string("/sys/fs/cgroup/cpu.stat").await?
    );
    let create_resources_before = creation_resource_counters(Path::new("/sys/fs/cgroup")).await;
    let started = Instant::now();
    let stage = |name: &str| {
        eprintln!(
            "real KVM create {name}: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
    };
    client.fixture_restore(&claim, fence).await?;
    stage("restore");
    let rpc = guest(&identity, &claim, &token, database.clone())?;
    rpc.verify_identity("33333333-3333-4333-8333-333333333333")
        .await?;
    rpc.write_file(
        "/workspace/continuity.txt",
        b"private-home-continuity",
        "missing",
    )
    .await?;
    stage("files");
    let terminal = rpc
        .create_terminal("fixture-terminal-continuity", "/workspace", 80, 24)
        .await?
        .session;
    let (pid, reconnect) = terminal_round_trip(&rpc, &terminal.id, "", 1).await?;
    stage("terminal");
    rpc.codex_call("model/list", json!({})).await?;
    stage("codex");
    let create_ms = started.elapsed().as_secs_f64() * 1000.0;
    eprintln!("real KVM prepared creation: {create_ms:.2} ms");
    let create_resources_after = creation_resource_counters(Path::new("/sys/fs/cgroup")).await;
    fs::write(
        "/work/creation-resources.json",
        serde_json::to_vec(&json!({
            "createMs": create_ms,
            "scope": "fixture cgroup; counter snapshots collected outside the timed creation boundary",
            "before": create_resources_before,
            "after": create_resources_after,
        }))?,
    )
    .await?;
    eprintln!(
        "real KVM create CPU after:\n{}",
        fs::read_to_string("/sys/fs/cgroup/cpu.stat").await?
    );
    let (_, file, _) = tokio::try_join!(
        rpc.verify_identity("33333333-3333-4333-8333-333333333333"),
        rpc.read_file("/workspace/continuity.txt"),
        rpc.codex_call("model/list", json!({})),
    )?;
    ensure!(
        file.content == b"private-home-continuity",
        "concurrent guest requests changed the retained file"
    );
    eprintln!("real KVM concurrent guest requests passed");
    let mut foreign = claim.clone();
    foreign.microvm_uid = "66666666-6666-4666-8666-666666666666".into();
    ensure!(
        guest(&identity, &foreign, &token, database.clone())?
            .verify_identity("33333333-3333-4333-8333-333333333333")
            .await
            .is_err(),
        "foreign owner accessed the guest"
    );
    for action in ["sleep", "stop"] {
        ensure!(
            client.lifecycle(action, &foreign, fence).await.is_err(),
            "foreign owner changed the guest lifecycle"
        );
        ensure!(
            client.status().await?.state.serves(&claim),
            "rejected lifecycle request fenced the current owner"
        );
    }
    rpc.write_file(
        "/workspace/kvm-admin.sh",
        &fs::read("/fixture/test-guest-admin.sh").await?,
        "missing",
    )
    .await?;
    let reconnect = guest_administration(&rpc, &terminal.id, &reconnect).await?;
    let responsiveness = responsiveness(&rpc).await?;
    let mut timings = Vec::with_capacity(samples);
    let mut memory = Vec::with_capacity(samples);
    let mut reconnect = reconnect;
    for index in 0..samples {
        use std::io::Write;
        writeln!(
            authority
                .0
                .stdin
                .as_mut()
                .context("authority stdin closed")?,
            "rotate"
        )?;
        let awake_memory = cgroup_memory().await?;
        let vmm_rss = firecracker_rss().await?.context("awake guest has no VMM")?;
        let save_started = Instant::now();
        let sleeping = client.lifecycle("sleep", &claim, fence).await?;
        let sleep_ms = save_started.elapsed().as_secs_f64() * 1000.0;
        ensure!(
            matches!(sleeping.state, SlotState::Sleeping { .. }),
            "sleep not committed"
        );
        ensure!(firecracker_rss().await?.is_none(), "sleep left a live VMM");
        eprintln!("real KVM sleep {}: {sleep_ms:.2} ms; VMM gone", index + 1);
        memory.push(
            json!({"awakeVmmRssBytes":vmm_rss, "awakeCgroup":awake_memory,
            "sleepCgroup":cgroup_memory().await?, "sleepMs":sleep_ms}),
        );
        let mut wrong = claim.clone();
        wrong.epoch += 1;
        ensure!(
            client.fixture_restore(&wrong, fence).await.is_err(),
            "wrong epoch restored the guest"
        );
        if index == 0 {
            tokio::time::sleep(Duration::from_secs(3 * 60)).await;
        }
        eprintln!(
            "real KVM resume {} CPU before:\n{}",
            index + 1,
            fs::read_to_string("/sys/fs/cgroup/cpu.stat").await?
        );
        eprintln!(
            "real KVM resume {} IO before:\n{}",
            index + 1,
            optional_counter(Path::new("/sys/fs/cgroup/io.stat")).await
        );
        eprintln!(
            "real KVM resume {} memory before: {}",
            index + 1,
            cgroup_memory().await?
        );
        let started = Instant::now();
        let stage = |name: &str| {
            eprintln!(
                "real KVM resume {} {name}: {:.2} ms cumulative",
                index + 1,
                started.elapsed().as_secs_f64() * 1000.0
            );
        };
        client.fixture_restore(&claim, fence).await?;
        stage("restore");
        let rpc = guest(&identity, &claim, &token, database.clone())?;
        rpc.verify_identity("33333333-3333-4333-8333-333333333333")
            .await?;
        ensure!(
            rpc.read_file("/workspace/continuity.txt").await?.content == b"private-home-continuity",
            "retained file changed"
        );
        stage("files");
        let (restored_pid, next_token) =
            terminal_round_trip(&rpc, &terminal.id, &reconnect, index + 2).await?;
        ensure!(restored_pid == pid, "resume replaced the shell process");
        reconnect = next_token;
        stage("terminal");
        rpc.codex_call("model/list", json!({})).await?;
        stage("codex");
        let resume_ms = started.elapsed().as_secs_f64() * 1000.0;
        timings.push(resume_ms);
        eprintln!("real KVM resume {}: {resume_ms:.2} ms", index + 1);
        eprintln!(
            "real KVM resume {} CPU after:\n{}",
            index + 1,
            fs::read_to_string("/sys/fs/cgroup/cpu.stat").await?
        );
        eprintln!(
            "real KVM resume {} IO after:\n{}",
            index + 1,
            optional_counter(Path::new("/sys/fs/cgroup/io.stat")).await
        );
        eprintln!(
            "real KVM resume {} memory after: {}",
            index + 1,
            cgroup_memory().await?
        );
    }
    let rpc = guest(&identity, &claim, &token, database.clone())?;
    rpc.open_browser().await?;
    let browser_mcp = rpc
        .codex_call("mcpServerStatus/list", json!({"limit":50}))
        .await?;
    ensure!(
        browser_mcp.result["data"]
            .as_array()
            .is_some_and(|servers| servers.iter().any(|server| {
                server["name"] == "tengri_browser"
                    && server["tools"]
                        .as_object()
                        .is_some_and(|tools| tools.values().any(|tool| tool["name"] == "computer"))
            })),
        "real guest Codex did not install its browser computer tool"
    );
    disk_read_error(&rpc).await?;
    ensure!(
        client.status().await?.state.serves(&claim),
        "disk error lost the current owner"
    );
    rpc.verify_identity("33333333-3333-4333-8333-333333333333")
        .await?;
    client.lifecycle("stop", &claim, fence).await?;
    let mut sorted_timings = timings.clone();
    sorted_timings.sort_by(f64::total_cmp);
    let p95 = (samples >= 50).then(|| sorted_timings[(samples * 95).div_ceil(100) - 1]);
    let resume_budget_ms = p95.unwrap_or(sorted_timings[samples - 1]);
    fs::write("/work/result.json", serde_json::to_vec_pretty(&json!({
        "boundary":"slot mTLS request through real guest file, PTY and initialized Codex RPC",
        "excludes":["BFF authentication", "Kubernetes API latency", "six concurrent guests", "fresh creation distribution", "raw PVC allocation"],
        "validationMode":if p95.is_some() { "benchmark" } else { "smoke" },
        "cpuMax":cpu_max.trim(),
        "createSamples":1,"createMs":create_ms,"resumeSamples":samples,
        "resumeP50Ms":sorted_timings[(samples * 50).div_ceil(100) - 1],"resumeP95Ms":p95,"resumeMaxMs":sorted_timings[samples - 1],"resumeMs":timings,
        "sleepVmmGone":true,"snapshotResidentBytes":0,"sameShellPid":pid,"fileContinuity":true,
        "memoryAndSleep":memory,"guestAdministration":true,"concurrentGuestRequests":true,
        "browserStarted":true,"browserComputerToolInstalled":true,
        "responsiveness":responsiveness,"diskReadErrorReported":true
    }))?).await?;
    runner_task.abort();
    supervisor_task.abort();
    renew_task.abort();
    database.release(fence).await?;
    ensure!(
        create_ms < 1000.0,
        "slot prepared creation is {create_ms:.2} ms"
    );
    ensure!(
        resume_budget_ms < 1000.0,
        "slot resume acceptance latency is {resume_budget_ms:.2} ms"
    );
    Ok(())
}

async fn guest_administration(rpc: &RpcClient, id: &str, token: &str) -> anyhow::Result<String> {
    let (sender, receiver) = mpsc::channel(4);
    sender
        .send(proto::TerminalInput {
            action: Some(proto::terminal_input::Action::Attach(
                proto::TerminalAttach {
                    id: id.into(),
                    reconnect_token: token.into(),
                    since: 0,
                    columns: 80,
                    rows: 24,
                },
            )),
        })
        .await?;
    let mut stream = rpc.attach_terminal(ReceiverStream::new(receiver)).await?;
    let ready = stream
        .message()
        .await?
        .context("guest administration terminal closed")?;
    let Some(proto::terminal_output::Event::Ready(ready)) = ready.event else {
        anyhow::bail!("guest administration terminal was not ready")
    };
    sender.send(proto::TerminalInput { action: Some(proto::terminal_input::Action::Input(
        b"bash /home/nanoagent/workspace/kvm-admin.sh --runtime; TENGRI_ADMIN_RESULT=$?; rm /home/nanoagent/workspace/kvm-admin.sh; printf '\\nTENGRI_ADMIN_%s_DONE\\n' \"$TENGRI_ADMIN_RESULT\"\n".to_vec()
    )) }).await?;
    tokio::time::timeout(Duration::from_secs(300), async {
        let mut output = Vec::new();
        while let Some(message) = stream.message().await? {
            if let Some(proto::terminal_output::Event::Output(data)) = message.event {
                output.extend(data.data);
                ensure!(
                    output.len() <= 1 << 20,
                    "guest administration output exceeds limit"
                );
                let output = String::from_utf8_lossy(&output);
                for suffix in output.split("TENGRI_ADMIN_").skip(1) {
                    if let Some((code, _)) = suffix.split_once("_DONE")
                        && let Ok(code) = code.parse::<u32>()
                    {
                        ensure!(code == 0, "real guest administration failed: {output}");
                        return Ok::<_, anyhow::Error>(());
                    }
                }
            }
        }
        anyhow::bail!("guest administration terminal closed")
    })
    .await
    .context("real guest administration timed out")??;
    Ok(ready.token)
}

fn guest(
    identity: &WorkloadIdentity,
    claim: &Claim,
    token: &str,
    database: std::sync::Arc<crate::control::Database>,
) -> anyhow::Result<RpcClient> {
    let tls =
        identity.guest_tls(identity.guest_id("tengri", "33333333-3333-4333-8333-333333333333")?)?;
    let channel = identity.guest_channel("127.0.0.1:8443".parse()?, tls)?;
    RpcClient::fixture_for_runtime(
        channel,
        token,
        claim.clone(),
        "33333333-3333-4333-8333-333333333333".into(),
        database,
    )
    .map_err(Into::into)
}

async fn terminal_round_trip(
    rpc: &RpcClient,
    id: &str,
    token: &str,
    counter: usize,
) -> anyhow::Result<(u32, String)> {
    let (sender, receiver) = mpsc::channel(4);
    sender
        .send(proto::TerminalInput {
            action: Some(proto::terminal_input::Action::Attach(
                proto::TerminalAttach {
                    id: id.into(),
                    reconnect_token: token.into(),
                    since: 0,
                    columns: 80,
                    rows: 24,
                },
            )),
        })
        .await?;
    let mut stream = rpc.attach_terminal(ReceiverStream::new(receiver)).await?;
    let ready = stream
        .message()
        .await?
        .context("terminal closed before readiness")?;
    let proto::terminal_output::Event::Ready(ready) =
        ready.event.context("missing terminal event")?
    else {
        anyhow::bail!("terminal not ready")
    };
    let command = b"TENGRI_COUNTER=${TENGRI_COUNTER:-0}; TENGRI_COUNTER=$((TENGRI_COUNTER + 1)); printf '\\nKVM_%s_PID_%s_END\\n' \"$TENGRI_COUNTER\" \"$$\"\n";
    sender
        .send(proto::TerminalInput {
            action: Some(proto::terminal_input::Action::Input(command.to_vec())),
        })
        .await?;
    let marker = format!("KVM_{counter}_PID_");
    let pid = tokio::time::timeout(Duration::from_secs(5), async {
        let mut output = Vec::new();
        while let Some(message) = stream.message().await? {
            if let Some(proto::terminal_output::Event::Output(data)) = message.event {
                output.extend(data.data);
                ensure!(
                    output.len() <= 1 << 20,
                    "terminal output exceeds the probe limit"
                );
                let output = String::from_utf8_lossy(&output);
                if let Some(rest) = output.split(&marker).nth(1)
                    && let Some(pid) = rest.split("_END").next()
                    && let Ok(pid) = pid.parse::<u32>()
                {
                    return Ok(pid);
                }
            }
        }
        anyhow::bail!("terminal closed before its round trip")
    })
    .await??;
    Ok((pid, ready.token))
}

struct TerminalProbe {
    sender: mpsc::Sender<proto::TerminalInput>,
    stream: tonic::Streaming<proto::TerminalOutput>,
    output: ProbeOutput,
}

impl TerminalProbe {
    async fn open(rpc: &RpcClient, name: &str) -> anyhow::Result<Self> {
        let terminal = rpc
            .create_terminal(name, "/workspace", 100, 30)
            .await?
            .session;
        let (sender, receiver) = mpsc::channel(4);
        sender
            .send(proto::TerminalInput {
                action: Some(proto::terminal_input::Action::Attach(
                    proto::TerminalAttach {
                        id: terminal.id,
                        columns: 100,
                        rows: 30,
                        ..Default::default()
                    },
                )),
            })
            .await?;
        let mut stream = rpc.attach_terminal(ReceiverStream::new(receiver)).await?;
        let first = stream
            .message()
            .await?
            .context("probe terminal closed before readiness")?;
        ensure!(
            matches!(first.event, Some(proto::terminal_output::Event::Ready(_))),
            "probe terminal was not ready"
        );
        Ok(Self {
            sender,
            stream,
            output: ProbeOutput::default(),
        })
    }

    async fn input(&self, command: &[u8]) -> anyhow::Result<()> {
        self.sender
            .send(proto::TerminalInput {
                action: Some(proto::terminal_input::Action::Input(command.to_vec())),
            })
            .await?;
        Ok(())
    }

    async fn marker(&mut self, marker: &[u8]) -> anyhow::Result<()> {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if self.output.take_marker(marker) {
                    return Ok(());
                }
                let message = self
                    .message()
                    .await?
                    .context("probe terminal closed before marker")?;
                match message.event {
                    Some(proto::terminal_output::Event::Error(error)) => {
                        anyhow::bail!("probe terminal: {error}")
                    }
                    Some(proto::terminal_output::Event::ExitCode(code)) => {
                        anyhow::bail!("probe terminal exited: {code}")
                    }
                    _ => {}
                }
            }
        })
        .await
        .with_context(|| {
            format!(
                "probe marker {:?} timed out; terminal output tail: {:?}",
                String::from_utf8_lossy(marker),
                self.output.diagnostic_tail()
            )
        })?
    }

    async fn message(&mut self) -> anyhow::Result<Option<proto::TerminalOutput>> {
        let message = self.stream.message().await?;
        if let Some(proto::terminal_output::Event::Output(data)) =
            message.as_ref().and_then(|message| message.event.as_ref())
        {
            let replies = self.output.append(&data.data)?;
            if !replies.is_empty() {
                self.input(&replies).await?;
            }
        }
        Ok(message)
    }

    async fn ping(&mut self) -> anyhow::Result<Duration> {
        let started = Instant::now();
        self.sender
            .send(proto::TerminalInput {
                action: Some(proto::terminal_input::Action::Ping(proto::Empty {})),
            })
            .await?;
        tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(message) = self.message().await? {
                match message.event {
                    Some(proto::terminal_output::Event::Pong(_)) => return Ok(started.elapsed()),
                    Some(proto::terminal_output::Event::Error(error)) => {
                        anyhow::bail!("probe heartbeat: {error}")
                    }
                    Some(proto::terminal_output::Event::ExitCode(code)) => {
                        anyhow::bail!("probe terminal exited: {code}")
                    }
                    _ => {}
                }
            }
            anyhow::bail!("probe terminal closed before heartbeat")
        })
        .await
        .context("probe heartbeat timed out")?
    }
}

async fn responsiveness(rpc: &RpcClient) -> anyhow::Result<serde_json::Value> {
    let started = Instant::now();
    let mut terminal = TerminalProbe::open(rpc, "fixture-responsiveness").await?;
    terminal
        .input(b"printf '\\036TENGRI_OUTPUT_READY\\037'\n")
        .await?;
    terminal.marker(b"\x1eTENGRI_OUTPUT_READY\x1f").await?;
    let first_output_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    terminal.input(&editor_probe_command()).await?;
    terminal.marker(EDITOR_READY).await?;
    let editor_ms = started.elapsed().as_secs_f64() * 1000.0;
    terminal.input(b"\x1b:qall!\r").await?;
    terminal.marker(b"\x1eTENGRI_EDITOR_EXIT\x1f").await?;
    let cpu_before = fs::read_to_string("/sys/fs/cgroup/cpu.stat").await?;
    let io_before = optional_counter(Path::new("/sys/fs/cgroup/io.pressure")).await;
    let memory_before = cgroup_memory().await?;
    let memory_pressure_before =
        optional_counter(Path::new("/sys/fs/cgroup/memory.pressure")).await;
    let vmm_tasks = vmm_diagnostic_tasks().await?;
    let diagnostic_started = Instant::now();
    let stop_diagnostics = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped = stop_diagnostics.clone();
    let diagnostics = tokio::spawn(async move {
        let mut samples = Vec::new();
        let mut interval = tokio::time::interval(Duration::from_millis(50));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let _ = tokio::time::timeout(Duration::from_secs(12), async {
            for _ in 0..240 {
                interval.tick().await;
                if stopped.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                let at_ms = diagnostic_started.elapsed().as_secs_f64() * 1000.0;
                let mut tasks = Vec::new();
                for path in &vmm_tasks {
                    tasks.push(json!({
                        "tid":path.file_name().unwrap().to_string_lossy(),
                        "stat":optional_counter(&path.join("stat")).await,
                        "schedstat":optional_counter(&path.join("schedstat")).await,
                        "wait":optional_counter(&path.join("wchan")).await,
                    }));
                }
                samples.push(json!({
                    "atMs":at_ms,"collectedInMs":diagnostic_started.elapsed().as_secs_f64()*1000.0-at_ms,
                    "tasks":tasks,
                }));
            }
        })
        .await;
        samples
    });
    terminal.input(b"timeout 8s sh -c 'while :; do dd if=/dev/zero of=/workspace/.tengri-kvm-io bs=1M count=16 conv=fdatasync status=none || exit 1; done' >/tmp/tengri-kvm-io.log 2>&1 & TENGRI_IO=$!; printf '\\036TENGRI_IO_READY\\037'; wait \"$TENGRI_IO\"; TENGRI_IO_RESULT=$?; rm -f /workspace/.tengri-kvm-io; printf '\\036TENGRI_IO_END_%s\\037' \"$TENGRI_IO_RESULT\"\n").await?;
    terminal.marker(b"\x1eTENGRI_IO_READY\x1f").await?;
    let mut heartbeats = Vec::with_capacity(50);
    let mut heartbeat_windows = Vec::with_capacity(50);
    let mut peak_workers = 0;
    for _ in 0..50 {
        let at_ms = diagnostic_started.elapsed().as_secs_f64() * 1000.0;
        let duration_ms = terminal.ping().await?.as_secs_f64() * 1000.0;
        heartbeats.push(duration_ms);
        heartbeat_windows.push(json!({"atMs":at_ms,"durationMs":duration_ms}));
        peak_workers = peak_workers.max(uring_workers().await?);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    terminal.marker(b"\x1eTENGRI_IO_END_124\x1f").await?;
    stop_diagnostics.store(true, std::sync::atomic::Ordering::Relaxed);
    let samples = diagnostics.await.context("VMM diagnostic task failed")?;
    fs::write(
        "/work/io-responsiveness.json",
        serde_json::to_vec(&json!({
            "heartbeats":heartbeat_windows,"samples":samples,"memoryBefore":memory_before,
            "memoryAfter":cgroup_memory().await?,"memoryPressureBefore":memory_pressure_before,
            "memoryPressureAfter":optional_counter(Path::new("/sys/fs/cgroup/memory.pressure")).await,
            "schedulerStatsEnabled":optional_counter(Path::new("/proc/sys/kernel/sched_schedstats")).await,
        }))?,
    )
    .await?;
    heartbeats.sort_by(f64::total_cmp);
    let p95_ms = heartbeats[47];
    let pids_limit = fs::read_to_string("/sys/fs/cgroup/pids.max").await?;
    let responsiveness = json!({
        "terminalFirstOutputMs":first_output_ms,"neovimFirstScreenMs":editor_ms,
        "heartbeatSamples":50,"heartbeatP95Ms":p95_ms,"heartbeatMaxMs":heartbeats[49],
        "heartbeatMs":heartbeats,"peakUringWorkers":peak_workers,"workerCgroupVerified":true,"pidsMax":pids_limit.trim().parse::<u64>()?,
        "cpuBefore":cpu_before,"cpuAfter":fs::read_to_string("/sys/fs/cgroup/cpu.stat").await?,
        "ioBefore":io_before,"ioAfter":optional_counter(Path::new("/sys/fs/cgroup/io.pressure")).await,
        "storageActivity":"eight seconds of repeated 16 MiB guest writes with fdatasync on the fixture home disk"
    });
    eprintln!("real KVM responsiveness: {responsiveness}");
    ensure!(
        pids_limit.trim() == "512",
        "fixture PID limit is not enforced"
    );
    ensure!(
        peak_workers > 0 && peak_workers <= 16,
        "io_uring worker count is outside the two-drive bound: {peak_workers}"
    );
    ensure!(
        first_output_ms < 300.0,
        "awake terminal output took {first_output_ms:.2} ms"
    );
    ensure!(
        editor_ms < 1000.0,
        "first managed Neovim screen took {editor_ms:.2} ms"
    );
    ensure!(
        p95_ms < 100.0,
        "terminal heartbeat p95 under disk activity was {p95_ms:.2} ms"
    );
    terminal
        .sender
        .send(proto::TerminalInput {
            action: Some(proto::terminal_input::Action::Terminate(proto::Empty {})),
        })
        .await?;
    Ok(responsiveness)
}

async fn vmm_diagnostic_tasks() -> anyhow::Result<Vec<PathBuf>> {
    let mut processes = fs::read_dir("/proc").await?;
    while let Some(process) = processes.next_entry().await? {
        if process
            .file_name()
            .to_string_lossy()
            .parse::<u32>()
            .is_err()
        {
            continue;
        }
        let Ok(command) = fs::read(process.path().join("cmdline")).await else {
            continue;
        };
        if !command.starts_with(b"/usr/local/bin/firecracker\0") {
            continue;
        }
        let mut selected = Vec::new();
        let mut tasks = fs::read_dir(process.path().join("task")).await?;
        while let Some(task) = tasks.next_entry().await? {
            let Ok(name) = fs::read_to_string(task.path().join("comm")).await else {
                continue;
            };
            if task.file_name() == process.file_name() || name.starts_with("fc_vcpu") {
                selected.push(task.path());
            }
        }
        ensure!(
            selected.len() == 5,
            "expected one VMM main thread and four vCPUs"
        );
        return Ok(selected);
    }
    anyhow::bail!("awake guest has no Firecracker process")
}

async fn creation_resource_counters(directory: &Path) -> serde_json::Value {
    let mut counters = serde_json::Map::new();
    for name in [
        "cpu.stat",
        "memory.stat",
        "io.stat",
        "cpu.pressure",
        "memory.pressure",
        "io.pressure",
    ] {
        counters.insert(name.into(), optional_counter(&directory.join(name)).await);
    }
    counters.into()
}

async fn optional_counter(path: &Path) -> serde_json::Value {
    let read = async {
        let mut bytes = Vec::new();
        fs::File::open(path)
            .await?
            .take(65_537)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 65_536 {
            return Err(std::io::Error::other("counter exceeds 64 KiB limit"));
        }
        String::from_utf8(bytes).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "counter is not UTF-8")
        })
    };
    match read.await {
        Ok(value) => json!({ "value": value }),
        Err(error) => json!({
            "unavailable": { "kind": format!("{:?}", error.kind()), "message": error.to_string() }
        }),
    }
}

#[tokio::test]
async fn missing_optional_counter_reports_its_absence_without_failing() {
    let path = std::env::temp_dir().join(format!("tengri-missing-psi-{}", uuid::Uuid::new_v4()));
    let diagnostic = optional_counter(&path).await;
    assert_eq!(diagnostic["unavailable"]["kind"], "NotFound");
    assert!(diagnostic["unavailable"]["message"].is_string());
}

#[tokio::test]
async fn creation_resource_counters_are_allowlisted_and_report_missing_files() {
    let directory =
        std::env::temp_dir().join(format!("tengri-create-counters-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).await.unwrap();
    fs::write(directory.join("memory.stat"), "pgfault 42\npgmajfault 7\n")
        .await
        .unwrap();
    fs::write(directory.join("unrelated"), "must not be collected")
        .await
        .unwrap();
    let counters = creation_resource_counters(&directory).await;
    assert_eq!(counters.as_object().unwrap().len(), 6);
    assert_eq!(
        counters["memory.stat"]["value"],
        "pgfault 42\npgmajfault 7\n"
    );
    assert_eq!(counters["io.pressure"]["unavailable"]["kind"], "NotFound");
    assert!(counters.get("unrelated").is_none());
    fs::remove_dir_all(directory).await.unwrap();
}

#[tokio::test]
async fn optional_counter_rejects_oversized_and_invalid_text_without_returning_content() {
    let path =
        std::env::temp_dir().join(format!("tengri-bounded-counter-{}", uuid::Uuid::new_v4()));
    fs::write(&path, vec![b'x'; 65_536]).await.unwrap();
    assert_eq!(
        optional_counter(&path).await["value"]
            .as_str()
            .unwrap()
            .len(),
        65_536
    );
    for content in [vec![b'x'; 65_537], vec![0xff]] {
        fs::write(&path, content).await.unwrap();
        let diagnostic = optional_counter(&path).await;
        assert!(diagnostic.get("value").is_none());
        assert!(diagnostic["unavailable"]["kind"].is_string());
    }
    fs::remove_file(path).await.unwrap();
}

async fn uring_workers() -> anyhow::Result<usize> {
    let expected = fs::read_to_string("/proc/self/cgroup").await?;
    let mut processes = fs::read_dir("/proc").await?;
    let mut count = 0;
    while let Some(process) = processes.next_entry().await? {
        if process
            .file_name()
            .to_string_lossy()
            .parse::<u32>()
            .is_err()
        {
            continue;
        }
        let Ok(command) = fs::read(process.path().join("cmdline")).await else {
            continue;
        };
        if !command.starts_with(b"/usr/local/bin/firecracker\0") {
            continue;
        }
        let mut tasks = fs::read_dir(process.path().join("task")).await?;
        while let Some(task) = tasks.next_entry().await? {
            let Ok(name) = fs::read_to_string(task.path().join("comm")).await else {
                continue;
            };
            if name.starts_with("iou-wrk-") {
                let Ok(cgroup) = fs::read_to_string(task.path().join("cgroup")).await else {
                    continue;
                };
                ensure!(
                    cgroup == expected,
                    "io_uring worker escaped the fixture cgroup"
                );
                count += 1;
            }
        }
    }
    Ok(count)
}

async fn disk_read_error(rpc: &RpcClient) -> anyhow::Result<()> {
    let mut terminal = TerminalProbe::open(rpc, "fixture-disk-error").await?;
    // Start the privileged probe before faulting the guest home.
    terminal
        .input(b"exec sudo -n /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/tmp LC_ALL=C /bin/bash --noprofile --norc -c 'printf \"\\036TENGRI_ROOT_READY\\037\"; exec /bin/bash --noprofile --norc -i'\n")
        .await?;
    terminal.marker(b"\x1eTENGRI_ROOT_READY\x1f").await?;
    // Quiesce home writers so an outstanding write cannot extend the truncated fixture disk.
    terminal
        .input(b"cd / && test \"$EUID\" -eq 0 && fsfreeze -f /home/nanoagent && printf '\\036TENGRI_DISK_READY\\037'\n")
        .await?;
    terminal.marker(b"\x1eTENGRI_DISK_READY\x1f").await?;
    // Fault only the disposable fixture disk, after continuity and browser acceptance.
    fs::OpenOptions::new()
        .write(true)
        .open("/work/slot/home.ext4")
        .await?
        .set_len(0)
        .await?;
    terminal.input(b"/usr/bin/dd if=/dev/vdb of=/dev/null bs=4096 skip=1024 count=1 iflag=direct 2>/tmp/tengri-kvm-disk-error; TENGRI_READ_RESULT=$?; if [ \"$TENGRI_READ_RESULT\" -ne 0 ] && /usr/bin/grep -q 'Input/output error' /tmp/tengri-kvm-disk-error; then printf '\\036TENGRI_DISK_ERROR_OK\\037'; else /usr/bin/cat /tmp/tengri-kvm-disk-error; printf '\\036TENGRI_DISK_ERROR_FAILED\\037'; fi\n").await?;
    terminal.marker(b"\x1eTENGRI_DISK_ERROR_OK\x1f").await?;
    terminal.ping().await?;
    Ok(())
}

async fn firecracker_rss() -> anyhow::Result<Option<u64>> {
    let mut entries = fs::read_dir("/proc").await?;
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_name().to_string_lossy().parse::<u32>().is_ok()
            && let Ok(command) = fs::read(entry.path().join("cmdline")).await
            && command.starts_with(b"/usr/local/bin/firecracker\0")
        {
            let status = fs::read_to_string(entry.path().join("status")).await?;
            let rss = status
                .lines()
                .find_map(|line| line.strip_prefix("VmRSS:"))
                .context("VMM has no RSS")?
                .split_whitespace()
                .next()
                .context("VMM RSS is empty")?
                .parse::<u64>()?;
            return Ok(Some(rss * 1024));
        }
    }
    Ok(None)
}

async fn cgroup_memory() -> anyhow::Result<serde_json::Value> {
    let status = fs::read_to_string("/sys/fs/cgroup/memory.stat").await?;
    let mut values = serde_json::Map::new();
    for line in status.lines() {
        let mut fields = line.split_whitespace();
        let key = fields.next().context("empty cgroup counter")?;
        if [
            "anon",
            "file",
            "file_dirty",
            "file_writeback",
            "pgfault",
            "pgmajfault",
            "pgscan",
            "pgsteal",
        ]
        .contains(&key)
        {
            values.insert(
                key.into(),
                json!(
                    fields
                        .next()
                        .context("missing cgroup counter value")?
                        .parse::<u64>()?
                ),
            );
        }
    }
    ensure!(
        values.contains_key("anon") && values.contains_key("file"),
        "fixture requires cgroup v2 memory accounting"
    );
    Ok(values.into())
}
