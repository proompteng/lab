use std::{
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};

#[cfg(not(target_os = "linux"))]
use anyhow::bail;
use anyhow::{Context, ensure};
use opentelemetry::global;
use reqwest::{Client, Method};
use serde_json::{Value, json};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::{Child, Command},
    time::{sleep, timeout},
};
use tracing::{Instrument, Span};
use tracing_opentelemetry::OpenTelemetrySpanExt;

use super::{GUEST_CONTROL_PORT, SlotConfig};

pub struct Vmm {
    child: Child,
    api: Client,
}

impl Vmm {
    #[cfg(test)]
    pub(super) fn from_child(child: Child) -> Self {
        Self {
            child,
            api: Client::new(),
        }
    }

    pub async fn spawn(config: &SlotConfig) -> anyhow::Result<Self> {
        #[cfg(test)]
        let started = Instant::now();
        let api_socket = config.directory.join("firecracker.sock");
        remove_socket(&api_socket).await?;
        remove_socket(&config.vsock()).await?;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(config.directory.join("firecracker.log"))?;
        let mut command = Command::new(&config.firecracker);
        command
            .env_clear()
            .args(["--api-sock"])
            .arg(&api_socket)
            .arg("--id")
            .arg(&config.identity.pod_uid)
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log)
            .kill_on_drop(true);
        #[cfg(target_os = "linux")]
        unsafe {
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::prctl(
                    libc::PR_CAP_AMBIENT,
                    libc::PR_CAP_AMBIENT_CLEAR_ALL,
                    0,
                    0,
                    0,
                ) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                #[repr(C)]
                struct Header {
                    version: u32,
                    pid: i32,
                }
                #[derive(Clone, Copy)]
                #[repr(C)]
                struct Data {
                    effective: u32,
                    permitted: u32,
                    inheritable: u32,
                }
                let header = Header {
                    version: 0x2008_0522,
                    pid: 0,
                };
                let data = [Data {
                    effective: 0,
                    permitted: 0,
                    inheritable: 0,
                }; 2];
                if libc::syscall(libc::SYS_capset, &header, data.as_ptr()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let api = Client::builder()
            .unix_socket(api_socket.as_path())
            .no_proxy()
            .timeout(Duration::from_secs(300))
            .build()?;
        let child = command.spawn().context("launch Firecracker")?;
        #[cfg(test)]
        eprintln!(
            "real KVM VMM spawn: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        #[cfg(test)]
        eprintln!(
            "real KVM VMM API client: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        Ok(Self { child, api })
    }

    async fn wait_api(&mut self, config: &SlotConfig) -> anyhow::Result<()> {
        #[cfg(test)]
        let started = Instant::now();
        let api_socket = config.directory.join("firecracker.sock");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            ensure!(self.running()?, "Firecracker exited before opening its API");
            if fs::try_exists(&api_socket).await? {
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "Firecracker API startup timed out"
            );
            sleep(Duration::from_millis(1)).await;
        }
        #[cfg(test)]
        eprintln!(
            "real KVM VMM API open: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        Ok(())
    }

    pub async fn boot(&mut self, config: &SlotConfig) -> anyhow::Result<()> {
        self.wait_api(config).await?;
        let vm = &*self;
        vm.request(
            Method::PUT,
            "/machine-config",
            json!({"vcpu_count": config.vcpus, "mem_size_mib": config.memory_mib}),
        )
        .await?;
        vm.request(Method::PUT, "/boot-source", json!({
            "kernel_image_path": config.kernel,
            "boot_args": "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/usr/local/sbin/tengri-init"
        })).await?;
        for (id, path, root) in [
            ("root", &config.root_disk, true),
            ("home", &config.home_disk, false),
        ] {
            vm.request(Method::PUT, &format!("/drives/{id}"), json!({
                "drive_id": id, "path_on_host": path, "is_root_device": root, "is_read_only": false,
                "cache_type": "Writeback", "io_engine": "Async"
            })).await?;
        }
        vm.request(
            Method::PUT,
            "/vsock",
            json!({"guest_cid": 3, "uds_path": config.vsock()}),
        )
        .await?;
        vm.request(
            Method::PUT,
            "/network-interfaces/eth0",
            json!({
                "iface_id": "eth0", "host_dev_name": config.tap, "guest_mac": "06:00:ac:10:00:02"
            }),
        )
        .await?;
        vm.request(
            Method::PUT,
            "/actions",
            json!({"action_type": "InstanceStart"}),
        )
        .await?;
        Ok(())
    }

    pub async fn load(&mut self, config: &SlotConfig, directory: &Path) -> anyhow::Result<()> {
        ensure!(
            fs::metadata(directory.join("memory.bin")).await?.len()
                == u64::from(config.memory_mib) << 20,
            "snapshot memory length does not match the guest"
        );
        self.wait_api(config).await?;
        self.request(Method::PUT, "/snapshot/load", json!({
            "snapshot_path": directory.join("state.bin"),
            "mem_backend": { "backend_type": "File", "backend_path": directory.join("memory.bin") },
            "resume_vm": false
        })).await?;
        Ok(())
    }

    pub async fn resume(&self) -> anyhow::Result<()> {
        self.request(Method::PATCH, "/vm", json!({"state": "Resumed"}))
            .await
    }

    pub async fn save(&self, directory: &Path) -> anyhow::Result<()> {
        self.request(Method::PATCH, "/vm", json!({"state": "Paused"}))
            .await?;
        self.request(Method::PUT, "/snapshot/create", json!({
            "snapshot_type": "Full", "snapshot_path": directory.join("state.bin"), "mem_file_path": directory.join("memory.bin")
        })).await
    }

    async fn request(&self, method: Method, path: &str, body: Value) -> anyhow::Result<()> {
        let response = self
            .api
            .request(method.clone(), format!("http://localhost{path}"))
            .json(&body)
            .send()
            .await
            .with_context(|| format!("Firecracker {method} {path}"))?;
        ensure!(
            response.status().as_u16() == 204,
            "Firecracker {method} {path}: {}",
            response.text().await?
        );
        Ok(())
    }

    pub fn running(&mut self) -> anyhow::Result<bool> {
        Ok(self.child.try_wait()?.is_none())
    }

    pub async fn wait_guest(&mut self, path: &Path, allowance: Duration) -> anyhow::Result<()> {
        tokio::select! {
            status = self.child.wait() => {
                anyhow::bail!("Firecracker exited before guest readiness: {}", status?);
            }
            result = wait_guest(path, allowance) => result,
        }
    }

    pub async fn stop(&mut self) -> anyhow::Result<()> {
        self.child
            .kill()
            .await
            .context("terminate and reap Firecracker")
    }
}

async fn remove_socket(path: &Path) -> anyhow::Result<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("remove old VMM socket"),
    }
}

pub async fn connect_vsock(path: &Path, port: u32) -> anyhow::Result<UnixStream> {
    timeout(Duration::from_secs(5), async {
        let mut stream = UnixStream::connect(path).await?;
        stream
            .write_all(format!("CONNECT {port}\n").as_bytes())
            .await?;
        // Read only the handshake; buffered read-ahead would swallow guest bytes.
        let mut response = Vec::with_capacity(32);
        use tokio::io::AsyncReadExt;
        loop {
            let byte = stream.read_u8().await?;
            if byte == b'\n' {
                break;
            }
            ensure!(response.len() < 32, "invalid vsock handshake");
            response.push(byte);
        }
        let reply = std::str::from_utf8(&response)?;
        ensure!(
            reply
                .strip_prefix("OK ")
                .is_some_and(|p| p.parse::<u32>().is_ok()),
            "vsock connection rejected"
        );
        Ok::<_, anyhow::Error>(stream)
    })
    .await
    .context("vsock connection timed out")?
}

pub async fn guest_command(path: &Path, command: &Value) -> anyhow::Result<Value> {
    let operation = match command["action"].as_str() {
        Some("ready") => "guest.ready.control",
        Some("freeze") => "guest.freeze.control",
        Some("resume") => "guest.resume.control",
        _ => "guest.unknown.control",
    };
    let span = tracing::info_span!("guest.control", otel.name = operation, operation);
    let result = timeout(
        Duration::from_secs(30),
        async {
            loop {
                let mut stream = connect_vsock(path, GUEST_CONTROL_PORT)
                    .instrument(tracing::info_span!("guest.control.connect"))
                    .await?;
                let mut command = command.clone();
                let context = Span::current().context();
                let mut carrier = std::collections::HashMap::new();
                global::get_text_map_propagator(|propagator| {
                    propagator.inject_context(&context, &mut carrier);
                });
                if let Some(traceparent) = carrier.get("traceparent") {
                    command["traceparent"] = json!(traceparent);
                }
                let sent = Instant::now();
                if command["action"] == "resume" {
                    command["unixTimeNanos"] = json!(
                        chrono::Utc::now()
                            .timestamp_nanos_opt()
                            .context("host clock overflow")?
                    );
                }
                let mut bytes = serde_json::to_vec(&command)?;
                bytes.push(b'\n');
                stream
                    .write_all(&bytes)
                    .instrument(tracing::info_span!("guest.control.send"))
                    .await?;
                let mut reader = BufReader::new(stream);
                let mut reply = String::new();
                use tokio::io::AsyncReadExt;
                (&mut reader)
                    .take(4097)
                    .read_line(&mut reply)
                    .instrument(tracing::info_span!("guest.control.reply"))
                    .await?;
                ensure!(
                    reply.len() <= 4096 && reply.ends_with('\n'),
                    "invalid guest control response"
                );
                let reply: Value = serde_json::from_str(&reply)?;
                ensure!(
                    reply.get("ok").and_then(Value::as_bool) == Some(true),
                    "guest lifecycle failed: {}",
                    reply
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("invalid response")
                );
                if command["action"] != "resume" {
                    return Ok::<_, anyhow::Error>(reply);
                }
                let after_clock = reply["clockElapsedNanos"]
                    .as_u64()
                    .context("guest resume requires clock application timing")?;
                // The guest clock advances during readiness checks after it is set.
                let transfer = sent
                    .elapsed()
                    .checked_sub(Duration::from_nanos(after_clock))
                    .context("invalid guest clock application timing")?;
                if transfer <= Duration::from_millis(500) {
                    return Ok::<_, anyhow::Error>(reply);
                }
            }
        }
        .instrument(span.clone()),
    )
    .await
    .context("guest lifecycle timed out")
    .and_then(|result| result);
    if result.is_err() {
        span.set_status(opentelemetry::trace::Status::error("Operation failed"));
    }
    result
}

async fn wait_guest(path: &Path, allowance: Duration) -> anyhow::Result<()> {
    let deadline = Instant::now() + allowance;
    loop {
        match guest_command(path, &json!({"action": "ready"})).await {
            Ok(_) => return Ok(()),
            Err(error) if Instant::now() >= deadline => {
                return Err(error).context("guest preparation timed out");
            }
            Err(_) => sleep(Duration::from_millis(100)).await,
        }
    }
}

#[cfg(target_os = "linux")]
pub fn evict_memory(path: &Path) -> anyhow::Result<()> {
    use std::os::fd::AsRawFd;
    let file = std::fs::File::open(path)?;
    let size = usize::try_from(file.metadata()?.len())?;
    ensure!(size > 0, "empty memory snapshot");
    let fd = file.as_raw_fd();
    let result = unsafe { libc::posix_fadvise(fd, 0, 0, libc::POSIX_FADV_DONTNEED) };
    if result != 0 {
        return Err(std::io::Error::from_raw_os_error(result))
            .context("evict sleeping snapshot pages");
    }
    let page_size = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })?;
    let mut residency = vec![0_u8; size.div_ceil(page_size)];
    unsafe {
        let mapping = libc::mmap(
            std::ptr::null_mut(),
            size,
            libc::PROT_NONE,
            libc::MAP_PRIVATE,
            fd,
            0,
        );
        if mapping == libc::MAP_FAILED {
            return Err(std::io::Error::last_os_error()).context("map snapshot residency");
        }
        let result = libc::mincore(mapping, size, residency.as_mut_ptr());
        let error = std::io::Error::last_os_error();
        libc::munmap(mapping, size);
        if result != 0 {
            return Err(error).context("inspect sleeping snapshot residency");
        }
    }
    let resident_bytes = residency.iter().filter(|p| **p & 1 != 0).count() * page_size;
    ensure!(
        resident_bytes == 0,
        "sleep retained {resident_bytes} snapshot bytes in RAM"
    );
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn evict_memory(_: &Path) -> anyhow::Result<()> {
    bail!("snapshot RAM release requires Linux")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lifecycle_control_sends_only_traceparent_and_records_phases() {
        // Isolate the global tracing callsite cache from concurrent tests without a subscriber.
        if std::env::var_os("TENGRI_LIFECYCLE_TRACE_TEST").is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "slot::vmm::tests::lifecycle_control_sends_only_traceparent_and_records_phases",
                    "--nocapture",
                ])
                .env("TENGRI_LIFECYCLE_TRACE_TEST", "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        use opentelemetry::trace::TracerProvider;
        use opentelemetry_sdk::{
            propagation::TraceContextPropagator,
            trace::{SdkTracerProvider, SpanData, SpanExporter},
        };
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::layer::SubscriberExt;

        #[derive(Clone, Debug)]
        struct Spans(Arc<Mutex<Vec<SpanData>>>);
        impl SpanExporter for Spans {
            async fn export(
                &self,
                spans: Vec<SpanData>,
            ) -> opentelemetry_sdk::error::OTelSdkResult {
                self.0.lock().unwrap().extend(spans);
                Ok(())
            }
        }
        global::set_text_map_propagator(TraceContextPropagator::new());
        let exported = Spans(Arc::default());
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exported.clone())
            .build();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("fixture")));
        tracing::subscriber::set_global_default(subscriber).unwrap();
        let path = std::env::temp_dir().join(format!("tg-{}.sock", uuid::Uuid::new_v4()));
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            reader.get_mut().write_all(b"OK 1\n").await.unwrap();
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let command: Value = serde_json::from_str(&line).unwrap();
            reader
                .get_mut()
                .write_all(b"{\"ok\":true}\n")
                .await
                .unwrap();
            command
        });
        guest_command(&path, &json!({"action": "freeze"}))
            .await
            .unwrap();
        let command = peer.await.unwrap();
        fs::remove_file(path).await.unwrap();
        provider.force_flush().unwrap();
        let spans = exported.0.lock().unwrap();
        let control = spans
            .iter()
            .find(|span| span.name == "guest.freeze.control")
            .unwrap();
        assert_eq!(command.as_object().unwrap().len(), 2);
        assert_eq!(
            command["traceparent"],
            format!(
                "00-{}-{}-01",
                control.span_context.trace_id(),
                control.span_context.span_id()
            )
        );
        for phase in [
            "guest.control.connect",
            "guest.control.send",
            "guest.control.reply",
        ] {
            let span = spans
                .iter()
                .find(|span| span.name == phase)
                .unwrap_or_else(|| panic!("missing {phase}; exported spans: {spans:?}"));
            assert_eq!(span.parent_span_id, control.span_context.span_id());
        }
    }

    #[tokio::test]
    async fn resume_refreshes_clock_after_slow_guest_readiness() {
        let path = std::env::temp_dir().join(format!("tg-{}.sock", uuid::Uuid::new_v4()));
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let peer = tokio::spawn(async move {
            let mut ready_at = 0;
            for round in 1..=2 {
                let (stream, _) = listener.accept().await.unwrap();
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                reader.read_line(&mut line).await.unwrap();
                assert_eq!(line, format!("CONNECT {GUEST_CONTROL_PORT}\n"));
                reader.get_mut().write_all(b"OK 1\n").await.unwrap();
                line.clear();
                reader.read_line(&mut line).await.unwrap();
                let command: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(command["action"], "resume");
                if round == 1 {
                    sleep(Duration::from_millis(1100)).await;
                    ready_at = chrono::Utc::now().timestamp_nanos_opt().unwrap();
                    assert!(ready_at - command["unixTimeNanos"].as_i64().unwrap() > 1_000_000_000);
                } else {
                    assert!(command["unixTimeNanos"].as_i64().unwrap() >= ready_at);
                }
                let reply = format!("{{\"ok\":true,\"round\":{round},\"clockElapsedNanos\":0}}\n");
                reader.get_mut().write_all(reply.as_bytes()).await.unwrap();
            }
        });
        let reply = guest_command(&path, &json!({"action": "resume"}))
            .await
            .unwrap();
        fs::remove_file(path).await.unwrap();
        assert_eq!(reply["round"], 2);
        peer.await.unwrap();
    }

    #[tokio::test]
    async fn slow_readiness_after_setting_clock_does_not_repeat_resume() {
        let path = std::env::temp_dir().join(format!("tg-{}.sock", uuid::Uuid::new_v4()));
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            reader.get_mut().write_all(b"OK 1\n").await.unwrap();
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            let applied = Instant::now();
            sleep(Duration::from_millis(1100)).await;
            let elapsed = applied.elapsed().as_nanos();
            let reply = format!("{{\"ok\":true,\"clockElapsedNanos\":{elapsed}}}\n");
            reader.get_mut().write_all(reply.as_bytes()).await.unwrap();
        });
        let result = guest_command(&path, &json!({"action": "resume"})).await;
        fs::remove_file(path).await.unwrap();
        peer.await.unwrap();
        assert!(result.is_ok(), "healthy guest was retried: {result:?}");
    }

    #[tokio::test]
    async fn resume_clock_is_sampled_after_the_vsock_handshake() {
        let path = std::env::temp_dir().join(format!(
            "tg-{}.sock",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut handshake = String::new();
            reader.read_line(&mut handshake).await.unwrap();
            assert_eq!(handshake, format!("CONNECT {GUEST_CONTROL_PORT}\n"));
            let connected_at = chrono::Utc::now().timestamp_nanos_opt().unwrap();
            reader.get_mut().write_all(b"OK 1\n").await.unwrap();
            let mut command = String::new();
            reader.read_line(&mut command).await.unwrap();
            let command: Value = serde_json::from_str(&command).unwrap();
            reader
                .get_mut()
                .write_all(b"{\"ok\":true,\"clockElapsedNanos\":0}\n")
                .await
                .unwrap();
            (connected_at, command)
        });
        let stale = chrono::Utc::now().timestamp_nanos_opt().unwrap() - 10_000_000_000;
        guest_command(&path, &json!({"action": "resume", "unixTimeNanos": stale}))
            .await
            .unwrap();
        let (connected_at, command) = peer.await.unwrap();
        fs::remove_file(path).await.unwrap();
        assert!(command["unixTimeNanos"].as_i64().unwrap() >= connected_at);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn eviction_rejects_empty_snapshots_and_releases_synced_pages() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("tengri-memory-{}", uuid::Uuid::new_v4()));
        let mut file = std::fs::File::create(&path).unwrap();
        assert!(evict_memory(&path).is_err());
        file.write_all(&[1_u8; 4096]).unwrap();
        file.sync_all().unwrap();
        drop(file);
        evict_memory(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), [1_u8; 4096]);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn exited_vmm_fails_preparation_without_waiting_for_the_guest_deadline() {
        let child = Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap();
        let mut vm = Vmm {
            child,
            api: Client::new(),
        };
        let result = timeout(
            Duration::from_secs(1),
            vm.wait_guest(
                Path::new("/nonexistent-tengri-vmm-test.sock"),
                Duration::from_secs(35 * 60),
            ),
        )
        .await
        .expect("an exited VMM must fail preparation promptly");
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Firecracker exited")
        );
    }
}
