use std::{env, path::PathBuf};

use anyhow::bail;
use ofz::{
    bootstrap::{self, Manifest, Operation},
    commands,
    native::Native,
    proto::{
        platform_authorization_service_server::PlatformAuthorizationServiceServer,
        tengri_authorization_service_server::TengriAuthorizationServiceServer,
    },
    service::Service,
    sessions::Issuer,
    store::Database,
    transport,
};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("TLS crypto provider already installed"))?;
    let _telemetry = ofz::telemetry::init("ofz")?;
    if env::args().nth(1).as_deref() == Some("telemetry-check") {
        println!("{}", _telemetry.verify()?);
        return Ok(());
    }
    let database = Database::from_environment().await?;
    match env::args().nth(1).as_deref() {
        Some("migrate") => {
            database.migrate().await?;
            return Ok(());
        }
        Some("migrate-runtime") => {
            database.migrate_runtime().await?;
            return Ok(());
        }
        Some("onboard-policies") => {
            database.verify_schema().await?;
            let native = Native::new(
                &env::var("OFZ_SPICEDB_ENDPOINT")?,
                PathBuf::from(env::var("OFZ_SPICEDB_KEY_FILE")?),
            )?;
            let revision = ofz::platform::onboarding::execute(&database, &native).await?;
            println!("{}", serde_json::json!({"policy_revision":revision}));
            return Ok(());
        }
        Some(command @ ("bootstrap" | "activate")) => {
            if env::args().len() != 3 {
                bail!("bootstrap and activate require one protected manifest path");
            }
            let manifest = Manifest::read(std::path::Path::new(&env::args().nth(2).unwrap()))?;
            let native = Native::new(
                &env::var("OFZ_SPICEDB_ENDPOINT")?,
                PathBuf::from(env::var("OFZ_SPICEDB_KEY_FILE")?),
            )?;
            let operation = if command == "bootstrap" {
                Operation::Bootstrap
            } else {
                Operation::Activate
            };
            let report = bootstrap::execute(&database, &native, operation, manifest).await?;
            println!("{}", serde_json::to_string(&report)?);
            return Ok(());
        }
        Some("serve") | None => {}
        _ => bail!(
            "expected serve, migrate, migrate-runtime, onboard-policies, bootstrap or activate"
        ),
    }
    database.verify_schema().await?;
    tracing::debug!("control database schema verified");
    let native = Native::new(
        &env::var("OFZ_SPICEDB_ENDPOINT")?,
        PathBuf::from(env::var("OFZ_SPICEDB_KEY_FILE")?),
    )?;
    commands::recover(&database, &native).await?;
    tracing::debug!("pending commands reconciled");
    let issuer = Issuer::new(env::var("OFZ_OIDC_ISSUER")?)?;
    let tls = transport::server_config().await?;
    tracing::debug!("attested authorization transport initialized");
    let listener =
        TcpListener::bind(env::var("OFZ_LISTEN").unwrap_or_else(|_| "0.0.0.0:9443".into())).await?;
    tracing::info!(
        contract_version = ofz::CONTRACT_VERSION,
        "Ofz authorization API listening"
    );
    let server = transport::server()
        .layer(
            tower_http::trace::TraceLayer::new_for_grpc()
                .make_span_with(ofz::telemetry::RequestSpan)
                .on_failure(ofz::telemetry::grpc_failure),
        )
        .add_service(
            TengriAuthorizationServiceServer::new(Service::new(database.clone(), native.clone()))
                .max_decoding_message_size(128 * 1024)
                .max_encoding_message_size(1_048_576),
        )
        .add_service(
            PlatformAuthorizationServiceServer::new(ofz::platform::service::Service::new(
                database.clone(),
                native.clone(),
                issuer,
                ofz::platform::providers::Providers::from_environment()?,
            ))
            .max_decoding_message_size(128 * 1024)
            .max_encoding_message_size(1_048_576),
        )
        .serve_with_incoming_shutdown(transport::incoming(listener, tls), async {
            let _ = tokio::signal::ctrl_c().await;
        });
    tokio::select! {
        result = server => result?,
        () = commands::maintain_recovery(&database, &native) => {}
    }
    Ok(())
}
