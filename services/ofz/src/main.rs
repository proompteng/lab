use std::{env, path::PathBuf};

use anyhow::bail;
use ofz::{
    commands, native::Native, proto::authorization_service_server::AuthorizationServiceServer,
    service::Service, sessions::Issuer, store::Database, transport,
};
use tokio::net::TcpListener;
use tonic::transport::Server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("TLS crypto provider already installed"))?;
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let database = Database::from_environment().await?;
    match env::args().nth(1).as_deref() {
        Some("migrate") => {
            database.migrate().await?;
            return Ok(());
        }
        Some("serve") | None => {}
        _ => bail!("expected serve or migrate"),
    }
    database.verify_schema().await?;
    let native = Native::new(
        &env::var("OFZ_SPICEDB_ENDPOINT")?,
        PathBuf::from(env::var("OFZ_SPICEDB_KEY_FILE")?),
    )?;
    commands::recover(&database, &native).await?;
    let issuer = Issuer::new(
        env::var("OFZ_OIDC_ISSUER")?,
        env::var("OFZ_OIDC_CLIENT_ID")?,
    )?;
    let tls = transport::server_config().await?;
    let listener =
        TcpListener::bind(env::var("OFZ_LISTEN").unwrap_or_else(|_| "0.0.0.0:9443".into())).await?;
    tracing::info!(
        contract_version = ofz::CONTRACT_VERSION,
        "Ofz authorization API listening"
    );
    Server::builder()
        .load_shed(true)
        .concurrency_limit_per_connection(32)
        .timeout(std::time::Duration::from_secs(5))
        .add_service(
            AuthorizationServiceServer::new(Service::new(database, native, issuer))
                .max_decoding_message_size(65536)
                .max_encoding_message_size(1_048_576),
        )
        .serve_with_incoming_shutdown(transport::incoming(listener, tls), async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
