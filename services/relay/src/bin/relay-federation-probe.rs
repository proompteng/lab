use relay::{config, connector::Connector, credentials::Authentication, http::Method};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("TLS crypto provider already installed"))?;
    let mut input = Vec::new();
    tokio::io::stdin()
        .take(262_145)
        .read_to_end(&mut input)
        .await?;
    let mut config = config::Config::parse(&input)?;
    anyhow::ensure!(config.connectors.len() == 1, "probe requires one connector");
    let Some(config::Connector::Http {
        id,
        endpoint,
        ca_file,
        authentication,
        operations,
    }) = config.connectors.pop()
    else {
        anyhow::bail!("probe requires an HTTP connector");
    };
    anyhow::ensure!(
        matches!(authentication, Authentication::WorkloadIdentity { .. })
            && operations.len() == 1
            && matches!(operations[0].method, Method::Get),
        "probe requires workload identity authentication and one GET operation"
    );
    let operation = operations[0].operation.name.clone();
    let connector = relay::http::Http::new(
        id,
        &endpoint,
        ca_file.as_deref(),
        authentication,
        operations,
    )?;
    let request = connector.normalize(&operation, b"{}")?;
    let output = connector
        .execute(&request, None)
        .await
        .map_err(|failure| failure.status)?;
    let mut stdout = tokio::io::stdout();
    stdout.write_all(&output.bytes).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}
