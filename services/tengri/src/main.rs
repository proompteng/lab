mod activity;
mod auth;
mod controller;
mod crd;
mod gateway;
mod grpc;
mod guest;
mod metrics;
mod pod;
mod tickets;

use std::{env, net::SocketAddr, time::Duration};

use activity::ActivityTracker;
use anyhow::Context as _;
use crd::MicroVMArchitecture;
use gateway::GatewayState;
use grpc::{
    ControlPlane, ControlPlaneConfig,
    proto::micro_vm_control_plane_server::MicroVmControlPlaneServer,
};
use kube::Client;
use tokio::{net::TcpListener, signal, sync::watch, time::timeout};
use tonic::transport::Server;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const DEFAULT_NAMESPACE: &str = "tengri";
const DEFAULT_LISTEN_ADDRESS: &str = "0.0.0.0:50051";
const DEFAULT_GATEWAY_ADDRESS: &str = "0.0.0.0:8080";
const DEFAULT_ARCHITECTURE: &str = "amd64";
const MAX_GRPC_MESSAGE_BYTES: usize = 16 << 20;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let namespace = env_value("TENGRI_NAMESPACE").unwrap_or_else(|| DEFAULT_NAMESPACE.to_owned());
    let listen_address = env_value("TENGRI_LISTEN_ADDRESS")
        .unwrap_or_else(|| DEFAULT_LISTEN_ADDRESS.to_owned())
        .parse::<SocketAddr>()
        .context("parse TENGRI_LISTEN_ADDRESS")?;
    let gateway_address = env_value("TENGRI_GATEWAY_ADDRESS")
        .unwrap_or_else(|| DEFAULT_GATEWAY_ADDRESS.to_owned())
        .parse::<SocketAddr>()
        .context("parse TENGRI_GATEWAY_ADDRESS")?;
    let architecture = parse_architecture(
        &env_value("TENGRI_GUEST_ARCHITECTURE").unwrap_or_else(|| DEFAULT_ARCHITECTURE.to_owned()),
    )?;
    let default_image = required_env("TENGRI_DEFAULT_IMAGE")?;
    let internal_hmac_secret = required_env("TENGRI_INTERNAL_HMAC_SECRET")?;
    let ticket_signing_secret = required_env("TENGRI_TICKET_SIGNING_SECRET")?;
    let public_url = required_env("TENGRI_PUBLIC_URL")?;
    let preview_url_template = required_env("TENGRI_PREVIEW_URL_TEMPLATE")?;
    let desktop_origin = required_env("TENGRI_DESKTOP_ORIGIN")?;
    let client = Client::try_default()
        .await
        .context("create Kubernetes client")?;
    let activity = ActivityTracker::new(client.clone(), namespace.clone());
    let service = ControlPlane::new(
        client.clone(),
        ControlPlaneConfig {
            namespace: namespace.clone(),
            default_image,
            architecture,
            internal_hmac_secret,
            ticket_signing_secret,
            public_url,
        },
        activity.clone(),
    )?;
    let tickets = service.tickets();
    let gateway_state = GatewayState::new(
        client.clone(),
        namespace.clone(),
        tickets.clone(),
        activity,
        preview_url_template,
        desktop_origin,
    )?;
    let gateway_listener = TcpListener::bind(gateway_address)
        .await
        .with_context(|| format!("bind HTTP gateway on {gateway_address}"))?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let controller_client = client.clone();
    let controller_namespace = namespace.clone();
    let mut controller_task = tokio::spawn(async move {
        controller::run(controller::ControllerContext {
            client: controller_client,
            namespace: controller_namespace,
            tickets,
        })
        .await;
        Ok::<(), anyhow::Error>(())
    });

    let grpc_shutdown = shutdown_rx.clone();
    let mut grpc_task = tokio::spawn(async move {
        Server::builder()
            .add_service(
                MicroVmControlPlaneServer::new(service)
                    .max_decoding_message_size(MAX_GRPC_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_GRPC_MESSAGE_BYTES),
            )
            .serve_with_shutdown(listen_address, wait_for_shutdown(grpc_shutdown))
            .await
            .context("serve gRPC control plane")
    });

    let gateway_shutdown = shutdown_rx;
    let mut gateway_task = tokio::spawn(async move {
        axum::serve(gateway_listener, gateway::router(gateway_state))
            .with_graceful_shutdown(wait_for_shutdown(gateway_shutdown))
            .await
            .context("serve HTTP and WebSocket gateway")
    });

    info!(%listen_address, %gateway_address, %namespace, ?architecture, "Tengri control plane ready");
    let result = tokio::select! {
        () = shutdown_signal() => Ok(()),
        result = &mut controller_task => task_result("controller", result),
        result = &mut grpc_task => task_result("gRPC server", result),
        result = &mut gateway_task => task_result("HTTP gateway", result),
    };

    let _ = shutdown_tx.send(true);
    controller_task.abort();
    let _ = timeout(Duration::from_secs(5), async {
        if !grpc_task.is_finished() {
            let _ = grpc_task.await;
        }
        if !gateway_task.is_finished() {
            let _ = gateway_task.await;
        }
    })
    .await;
    result
}

fn task_result(
    name: &str,
    result: Result<anyhow::Result<()>, tokio::task::JoinError>,
) -> anyhow::Result<()> {
    match result {
        Ok(Ok(())) => Err(anyhow::anyhow!("{name} stopped unexpectedly")),
        Ok(Err(error)) => Err(error).with_context(|| format!("{name} failed")),
        Err(error) => Err(anyhow::Error::new(error)).with_context(|| format!("{name} task failed")),
    }
}

async fn wait_for_shutdown(mut receiver: watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    warn!("shutdown signal received");
}

fn env_value(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn required_env(name: &str) -> anyhow::Result<String> {
    env_value(name).ok_or_else(|| anyhow::anyhow!("{name} is required"))
}

fn parse_architecture(value: &str) -> anyhow::Result<MicroVMArchitecture> {
    match value {
        "amd64" => Ok(MicroVMArchitecture::Amd64),
        "arm64" => Ok(MicroVMArchitecture::Arm64),
        _ => Err(anyhow::anyhow!(
            "TENGRI_GUEST_ARCHITECTURE must be amd64 or arm64"
        )),
    }
}
