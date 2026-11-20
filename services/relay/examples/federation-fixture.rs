//! Drives the actual adapters against the isolated Workload API and STS in federation.e2e.test.ts.
use relay::{config, connector::Connector};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let path = std::env::var("RELAY_CONFIG_FILE")?;
    let config = config::Config::parse(&std::fs::read(path)?)?;
    let mut connectors: Vec<Box<dyn Connector>> = Vec::new();
    for connector in config.connectors {
        connectors.push(match connector {
            config::Connector::Http {
                id,
                endpoint,
                ca_file,
                authentication,
                operations,
            } => Box::new(relay::http::Http::new(
                id,
                &endpoint,
                ca_file.as_deref(),
                authentication,
                operations,
            )?),
            config::Connector::Mcp {
                id,
                transport,
                operations,
            } => Box::new(relay::mcp::Mcp::new(id, transport, operations)?),
            _ => anyhow::bail!("HTTP or MCP fixture required"),
        });
    }
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let index: usize = line.parse()?;
        let connector = &connectors[index];
        let request = connector.normalize("read", br#"{"query":"approved"}"#)?;
        let results =
            futures::future::join_all((0..8).map(|_| connector.execute(&request, None))).await;
        let results: Vec<_> = results
            .into_iter()
            .map(|result| match result {
                Ok(output) => {
                    serde_json::json!({"ok": true, "body": String::from_utf8_lossy(&output.bytes)})
                }
                Err(failure) => serde_json::json!({"ok": false, "error": failure.status.message()}),
            })
            .collect();
        stdout
            .write_all(format!("{}\n", serde_json::to_string(&results)?).as_bytes())
            .await?;
        stdout.flush().await?;
    }
    Ok(())
}
