use serde::Deserialize;
use std::{collections::BTreeMap, os::unix::process::CommandExt, path::Path, process::Stdio};
use tonic::Status;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub program: String,
    pub arguments: Vec<String>,
    pub directory: String,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub secret_files: BTreeMap<String, String>,
}

pub(crate) struct Running {
    _group: ProcessGroup,
    pub child: tokio::process::Child,
}

// The adapter owns the process group across cancellation, including children that retain its pipes.
struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // process_group(0) gives the child its own PID as the process-group ID.
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

impl Profile {
    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            Path::new(&self.program).is_absolute()
                && Path::new(&self.directory).is_absolute()
                && self.arguments.len() <= 64
                && self
                    .arguments
                    .iter()
                    .all(|v| v.len() <= 4096 && !v.contains('\0'))
                && self.environment.len() + self.secret_files.len() <= 32
                && self
                    .environment
                    .keys()
                    .chain(self.secret_files.keys())
                    .all(|key| !key.is_empty()
                        && key.len() <= 128
                        && key
                            .bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'))
                && self
                    .environment
                    .values()
                    .all(|v| v.len() <= 16_384 && !v.contains('\0'))
                && self
                    .secret_files
                    .values()
                    .all(|path| Path::new(path).is_absolute())
                && self
                    .secret_files
                    .keys()
                    .all(|key| !self.environment.contains_key(key)),
            "invalid registered process"
        );
        Ok(())
    }
    pub(crate) async fn spawn(&self, stderr: Stdio) -> Result<Running, Status> {
        let mut command = tokio::process::Command::new(&self.program);
        command
            .args(&self.arguments)
            .current_dir(&self.directory)
            .env_clear()
            .envs(&self.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .kill_on_drop(true);
        command.as_std_mut().process_group(0);
        for (name, path) in &self.secret_files {
            command.env(name, crate::credentials::read_file(path).await?);
        }
        let child = command
            .spawn()
            .map_err(|_| Status::unavailable("registered process could not start"))?;
        let group = ProcessGroup(
            child
                .id()
                .ok_or_else(|| Status::internal("process ID missing"))?,
        );
        Ok(Running {
            _group: group,
            child,
        })
    }
}
