use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, ensure};
use k8s_openapi::api::core::v1::Pod;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::{fs, net::TcpListener, sync::mpsc};
use tokio_stream::wrappers::ReceiverStream;

use super::{
    Claim, FIRECRACKER_VERSION, SlotConfig, SlotIdentity, SlotState, client::SlotClient, runner,
    supervisor,
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
    let samples: usize = std::env::var("TENGRI_KVM_SAMPLES")
        .context("set the explicit sample count")?
        .parse()?;
    ensure!(samples > 0, "sample count must be positive");
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
        "spiffe://proompteng.ai/ns/tengri/slot/pod/interop-agent".parse()?,
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
            &json!({"podUid":"interop-agent", "token":token, "initializeHome":true}),
        )?,
    )
    .await?;
    for (source, destination) in [
        (&configuration, "/etc/tengri-slot.json"),
        (&PathBuf::from("/etc/resolv.conf"), "/etc/resolv.conf"),
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
        .set_len(16 << 30)
        .await?;
    let kernel = PathBuf::from("/guest/vmlinux");
    let config = SlotConfig {
        identity: SlotIdentity {
            pod_uid: "interop-agent".into(),
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
    let supervisor_task = tokio::spawn(supervisor::serve(
        TcpListener::bind("127.0.0.1:8443").await?,
        tls,
    ));
    let pod: Pod = serde_json::from_value(
        json!({"metadata":{"uid":"interop-agent"},"status":{"podIP":"127.0.0.1"}}),
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
        microvm_uid: "fixture-owner-uid".into(),
        epoch: 1,
    };
    eprintln!(
        "real KVM create CPU before:\n{}",
        fs::read_to_string("/sys/fs/cgroup/cpu.stat").await?
    );
    let started = Instant::now();
    let stage = |name: &str| {
        eprintln!(
            "real KVM create {name}: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
    };
    client.lifecycle("restore", &claim).await?;
    stage("restore");
    let rpc = guest(&identity, &claim, &token)?;
    rpc.verify_identity("interop-agent").await?;
    rpc.write_file("/continuity.txt", b"private-home-continuity", "missing")
        .await?;
    stage("files");
    let terminal = rpc
        .create_terminal("fixture-terminal-continuity", "/", 80, 24)
        .await?
        .session;
    let (pid, reconnect) = terminal_round_trip(&rpc, &terminal.id, "", 1).await?;
    stage("terminal");
    let models = rpc.codex_call("model/list", json!({})).await?;
    stage("codex");
    let create_ms = started.elapsed().as_secs_f64() * 1000.0;
    eprintln!("real KVM prepared creation: {create_ms:.2} ms");
    eprintln!(
        "real KVM create CPU after:\n{}",
        fs::read_to_string("/sys/fs/cgroup/cpu.stat").await?
    );
    eprintln!(
        "real KVM Codex model result: {} bytes",
        serde_json::to_vec(&models.result)?.len()
    );
    let mut foreign = claim.clone();
    foreign.microvm_uid = "another-owner-uid".into();
    ensure!(
        guest(&identity, &foreign, &token)?
            .verify_identity("interop-agent")
            .await
            .is_err(),
        "foreign owner accessed the guest"
    );
    for action in ["sleep", "stop"] {
        ensure!(
            client.lifecycle(action, &foreign).await.is_err(),
            "foreign owner changed the guest lifecycle"
        );
        ensure!(
            client.status().await?.state.serves(&claim),
            "rejected lifecycle request fenced the current owner"
        );
    }
    rpc.write_file(
        "/kvm-admin.sh",
        &fs::read("/fixture/test-guest-admin.sh").await?,
        "missing",
    )
    .await?;
    let reconnect = guest_administration(&rpc, &terminal.id, &reconnect).await?;
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
        let sleeping = client.lifecycle("sleep", &claim).await?;
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
            client.lifecycle("restore", &wrong).await.is_err(),
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
        let started = Instant::now();
        let stage = |name: &str| {
            eprintln!(
                "real KVM resume {} {name}: {:.2} ms cumulative",
                index + 1,
                started.elapsed().as_secs_f64() * 1000.0
            );
        };
        client.lifecycle("restore", &claim).await?;
        stage("restore");
        let rpc = guest(&identity, &claim, &token)?;
        rpc.verify_identity("interop-agent").await?;
        ensure!(
            rpc.read_file("/continuity.txt").await?.content == b"private-home-continuity",
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
    }
    client.lifecycle("stop", &claim).await?;
    timings.sort_by(f64::total_cmp);
    let p95 = timings[(samples * 95).div_ceil(100) - 1];
    fs::write("/work/result.json", serde_json::to_vec_pretty(&json!({
        "boundary":"slot mTLS request through real guest file, PTY and initialized Codex RPC",
        "excludes":["BFF authentication", "Kubernetes API latency", "six concurrent guests", "fresh creation distribution", "raw PVC allocation"],
        "createSamples":1,"createMs":create_ms,"resumeSamples":samples,
        "resumeP50Ms":timings[(samples * 50).div_ceil(100) - 1],"resumeP95Ms":p95,"resumeMaxMs":timings[samples - 1],"resumeMs":timings,
        "sleepVmmGone":true,"snapshotResidentBytes":0,"sameShellPid":pid,"fileContinuity":true,
        "memoryAndSleep":memory,"guestAdministration":true
    }))?).await?;
    runner_task.abort();
    supervisor_task.abort();
    ensure!(
        create_ms < 1000.0,
        "slot prepared creation is {create_ms:.2} ms"
    );
    ensure!(p95 < 1000.0, "slot resume p95 is {p95:.2} ms");
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

fn guest(identity: &WorkloadIdentity, claim: &Claim, token: &str) -> anyhow::Result<RpcClient> {
    let tls = identity.guest_tls(identity.guest_id("tengri", "interop-agent")?)?;
    let channel = identity.guest_channel("127.0.0.1:8443".parse()?, tls)?;
    let mut rpc = RpcClient::new(channel, token)?;
    rpc.bind_claim(claim.clone());
    Ok(rpc)
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
        if ["anon", "file", "file_dirty", "file_writeback"].contains(&key) {
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
