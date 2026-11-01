use crate::{
    connector::{Connector, Failure, Normalized, Output},
    registered::{Operation, Prepared, RegisteredOperation},
};
use platform_client::{authz::PlatformConnectionScope, relay::ConnectorOperation};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tonic::Status;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CliOperation {
    pub operation: Operation,
    pub process: crate::process::Profile,
}

pub struct Cli {
    id: String,
    operations: BTreeMap<String, (RegisteredOperation, CliOperation)>,
}

pub(crate) fn validate(operations: &[CliOperation]) -> anyhow::Result<()> {
    anyhow::ensure!(
        !operations.is_empty() && operations.len() <= 64,
        "invalid CLI profile size"
    );
    let mut names = BTreeSet::new();
    for entry in operations {
        let operation = RegisteredOperation::new(entry.operation.clone())?;
        anyhow::ensure!(
            names.insert(operation.name().to_owned()),
            "duplicate CLI operation"
        );
        entry.process.validate()?;
    }
    Ok(())
}

impl Cli {
    pub fn new(id: String, operations: Vec<CliOperation>) -> anyhow::Result<Self> {
        validate(&operations)?;
        let mut registered = BTreeMap::new();
        for entry in operations {
            let operation = RegisteredOperation::new(entry.operation.clone())?;
            registered.insert(operation.name().to_owned(), (operation, entry));
        }
        Ok(Self {
            id,
            operations: registered,
        })
    }
}

async fn read_bounded(stream: impl AsyncRead + Unpin) -> Result<Vec<u8>, Status> {
    let mut bytes = Vec::new();
    stream
        .take(262_145)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Status::unavailable("CLI response interrupted"))?;
    if bytes.len() > 262_144 {
        return Err(Status::resource_exhausted(
            "CLI response exceeds its byte budget",
        ));
    }
    Ok(bytes)
}

#[async_trait::async_trait]
impl Connector for Cli {
    fn id(&self) -> &str {
        &self.id
    }
    fn operations(&self, access: Option<&[PlatformConnectionScope]>) -> Vec<ConnectorOperation> {
        self.operations
            .values()
            .filter_map(|(operation, _)| operation.discovery(&self.id, access))
            .collect()
    }
    fn normalize(&self, operation: &str, arguments: &[u8]) -> Result<Normalized, Status> {
        self.operations
            .get(operation)
            .ok_or_else(|| Status::not_found("CLI operation not registered"))?
            .0
            .normalize(arguments)
    }
    async fn execute(&self, request: &Normalized) -> Result<Output, Failure> {
        let prepared: Prepared =
            serde_json::from_slice(&request.prepared_request).map_err(|_| Failure {
                status: Status::internal("invalid normalized CLI request"),
                upstream_status: 0,
            })?;
        let (_, profile) = self
            .operations
            .get(&prepared.operation)
            .ok_or_else(|| Failure {
                status: Status::internal("normalized CLI operation missing"),
                upstream_status: 0,
            })?;
        let result = async {
            let mut running = profile.process.spawn(Stdio::piped()).await?;
            let child = &mut running.child;
            let mut stdin = child.stdin.take().expect("piped stdin");
            let mut input = serde_json::to_vec(&prepared.arguments)
                .map_err(|_| Status::internal("encode CLI arguments"))?;
            input.push(b'\n');
            let write = async move {
                stdin
                    .write_all(&input)
                    .await
                    .map_err(|_| Status::unavailable("CLI input interrupted"))?;
                drop(stdin);
                Ok::<_, Status>(())
            };
            let ((), stdout, _) = tokio::try_join!(
                write,
                read_bounded(child.stdout.take().expect("piped stdout")),
                read_bounded(child.stderr.take().expect("piped stderr"))
            )?;
            let status = child
                .wait()
                .await
                .map_err(|_| Status::unavailable("CLI exit status unavailable"))?;
            if !status.success() {
                return Err(Status::unavailable("registered CLI exited unsuccessfully"));
            }
            serde_json::from_slice::<serde_json::Value>(&stdout)
                .map_err(|_| Status::data_loss("CLI returned invalid JSON"))?;
            Ok(Output {
                bytes: stdout,
                content_type: "application/json".into(),
                upstream_status: 0,
            })
        };
        tokio::time::timeout(Duration::from_secs(10), result)
            .await
            .map_err(|_| Failure {
                status: Status::deadline_exceeded("CLI operation timed out"),
                upstream_status: 0,
            })?
            .map_err(|status| Failure {
                status,
                upstream_status: 0,
            })
    }
}
