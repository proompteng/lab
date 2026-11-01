use platform_client::{
    authz::platform_authorization_service_client::PlatformAuthorizationServiceClient,
    relay::relay_service_server::RelayServiceServer, tls,
};
use relay::{
    config::{Config, Connector},
    kubernetes::Kubernetes,
    service::Service,
};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("TLS crypto provider already installed"))?;
    let config = Config::parse(&std::fs::read(std::env::var("RELAY_CONFIG_FILE")?)?)?;
    let identity = tls::Identity::load("spiffe://proompteng.ai/ns/relay/sa/relay").await?;
    let channel = identity.channel(
        &std::env::var("OFZ_GRPC_TARGET")?,
        "spiffe://proompteng.ai/ns/ofz/sa/ofz-api",
    )?;
    let enrollment = PlatformAuthorizationServiceClient::new(channel.clone())
        .get_platform_configuration(platform_client::request(
            platform_client::authz::GetPlatformConfigurationRequest {},
        ))
        .await?
        .into_inner();
    let mut adapters: Vec<Box<dyn relay::connector::Connector>> = Vec::new();
    for connector in &config.connectors {
        match connector {
            Connector::Kubernetes {
                id,
                endpoint,
                ca_file,
                token_file,
                namespaces,
            } => adapters.push(Box::new(Kubernetes::new(
                id.clone(),
                endpoint.clone(),
                ca_file,
                token_file.clone(),
                namespaces.clone(),
            )?)),
            Connector::Http {
                id,
                endpoint,
                ca_file,
                bearer_token_file,
                operations,
            } => {
                adapters.push(Box::new(relay::http::Http::new(
                    id.clone(),
                    endpoint,
                    ca_file.as_deref(),
                    bearer_token_file.clone(),
                    operations.clone(),
                )?));
            }
            Connector::Cli { id, operations } => {
                adapters.push(Box::new(relay::cli::Cli::new(
                    id.clone(),
                    operations.clone(),
                )?));
            }
        }
    }
    let service = Service::new(enrollment.relay_clients, adapters, channel)?;
    let tls = identity.server_config(service.peer_authorizer())?;
    let enrolled = service.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            enrolled.refresh_enrollment().await;
        }
    });
    let listener = tokio::net::TcpListener::bind(
        std::env::var("RELAY_LISTEN").unwrap_or_else(|_| "0.0.0.0:9443".into()),
    )
    .await?;
    tonic::transport::Server::builder()
        .load_shed(true)
        .concurrency_limit_per_connection(32)
        .timeout(std::time::Duration::from_secs(30))
        .add_service(
            RelayServiceServer::new(service)
                .max_decoding_message_size(platform_client::MAX_RELAY_REQUEST_BYTES)
                .max_encoding_message_size(1_114_112),
        )
        .serve_with_incoming_shutdown(tls::incoming(listener, tls), async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
