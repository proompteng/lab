use std::{
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};

#[cfg(not(target_os = "linux"))]
use anyhow::bail;
use anyhow::{Context, ensure};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::{Child, Command},
    time::{sleep, timeout},
};

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

    async fn start(config: &SlotConfig) -> anyhow::Result<Self> {
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
        let child = command.spawn().context("launch Firecracker")?;
        #[cfg(test)]
        eprintln!(
            "real KVM VMM spawn: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        let api = Client::builder()
            .unix_socket(api_socket.as_path())
            .no_proxy()
            .timeout(Duration::from_secs(300))
            .build()?;
        #[cfg(test)]
        eprintln!(
            "real KVM VMM API client: {:.2} ms cumulative",
            started.elapsed().as_secs_f64() * 1000.0
        );
        let mut vm = Self { child, api };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            ensure!(vm.running()?, "Firecracker exited before opening its API");
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
        Ok(vm)
    }

    pub async fn boot(config: &SlotConfig) -> anyhow::Result<Self> {
        let vm = Self::start(config).await?;
        vm.request(
            Method::PUT,
            "/machine-config",
            json!({"vcpu_count": config.vcpus, "mem_size_mib": config.memory_mib}),
        )
        .await?;
        vm.request(Method::PUT, "/boot-source", json!({
            "kernel_image_path": config.kernel,
            "boot_args": format!("console={} reboot=k panic=1 pci=off root=/dev/vda rw init=/usr/local/sbin/tengri-init", if cfg!(target_arch = "aarch64") {"ttyAMA0"} else {"ttyS0"})
        })).await?;
        for (id, path, root) in [
            ("root", &config.root_disk, true),
            ("home", &config.home_disk, false),
        ] {
            vm.request(Method::PUT, &format!("/drives/{id}"), json!({
                "drive_id": id, "path_on_host": path, "is_root_device": root, "is_read_only": false,
                "cache_type": "Unsafe", "io_engine": "Sync"
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
        Ok(vm)
    }

    pub async fn load(config: &SlotConfig, directory: &Path) -> anyhow::Result<Self> {
        ensure!(
            fs::metadata(directory.join("memory.bin")).await?.len()
                == u64::from(config.memory_mib) << 20,
            "snapshot memory length does not match the guest"
        );
        let vm = Self::start(config).await?;
        vm.request(Method::PUT, "/snapshot/load", json!({
            "snapshot_path": directory.join("state.bin"),
            "mem_backend": { "backend_type": "File", "backend_path": directory.join("memory.bin") },
            "resume_vm": false
        })).await?;
        Ok(vm)
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
    timeout(Duration::from_secs(30), async {
        let mut stream = connect_vsock(path, GUEST_CONTROL_PORT).await?;
        let mut bytes = serde_json::to_vec(command)?;
        bytes.push(b'\n');
        stream.write_all(&bytes).await?;
        let mut reader = BufReader::new(stream);
        let mut reply = String::new();
        use tokio::io::AsyncReadExt;
        (&mut reader).take(4097).read_line(&mut reply).await?;
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
        Ok::<_, anyhow::Error>(reply)
    })
    .await
    .context("guest lifecycle timed out")?
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
