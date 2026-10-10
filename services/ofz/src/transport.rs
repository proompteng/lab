use std::{
    env, io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use anyhow::{Context as _, bail};
use futures::{Stream, StreamExt};
use spiffe::{SpiffeId, TrustDomain, X509Source, X509Svid, x509_source::SvidPicker};
use spiffe_rustls::{LocalOnly, authorizer, mtls_server};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_rustls::TlsAcceptor;
use tonic::{Request, Status, transport::server::Connected};

use crate::policy::{self, BFF_ID, CONNECTOR_BROKER_ID, CONTROLLER_ID, KUBE_BROKER_ID, OFZ_ID};

#[derive(Clone, Debug)]
pub struct Peer(pub String);

pub fn peer<T>(request: &Request<T>) -> Result<String, Status> {
    if request
        .metadata()
        .get("x-ofz-contract-version")
        .and_then(|value| value.to_str().ok())
        != Some("1")
    {
        return Err(Status::failed_precondition(
            "authorization contract mismatch",
        ));
    }
    request
        .extensions()
        .get::<Peer>()
        .filter(|peer| policy::allowed_workload(&peer.0))
        .map(|peer| peer.0.clone())
        .ok_or_else(|| Status::unauthenticated("attested workload required"))
}

struct ExactIdentity(SpiffeId);
impl SvidPicker for ExactIdentity {
    fn pick_svid(&self, svids: &[Arc<X509Svid>]) -> Option<usize> {
        svids.iter().position(|svid| svid.spiffe_id() == &self.0)
    }
}

pub async fn server_config() -> anyhow::Result<Arc<rustls::ServerConfig>> {
    let endpoint = env::var("SPIFFE_ENDPOINT_SOCKET").context("SPIFFE_ENDPOINT_SOCKET required")?;
    if !endpoint.starts_with("unix:///") || endpoint.contains(['\0', '?', '#']) {
        bail!("absolute SPIFFE Unix socket required");
    }
    let domain: TrustDomain = "proompteng.ai".parse()?;
    let source = X509Source::builder()
        .endpoint(endpoint)
        .picker(ExactIdentity(OFZ_ID.parse()?))
        .initial_sync_timeout(Duration::from_secs(30))
        .build()
        .await?;
    let peers: Vec<SpiffeId> = [BFF_ID, CONTROLLER_ID, KUBE_BROKER_ID, CONNECTOR_BROKER_ID]
        .iter()
        .map(|id| id.parse())
        .collect::<Result<_, _>>()?;
    Ok(Arc::new(
        mtls_server(source)
            .authorize(authorizer::exact(peers)?)
            .trust_domain_policy(LocalOnly(domain))
            .with_alpn_protocols([b"h2".as_slice()])
            .build()?,
    ))
}

pub struct Connection {
    stream: tokio_rustls::server::TlsStream<TcpStream>,
    peer: Peer,
}
impl Connected for Connection {
    type ConnectInfo = Peer;
    fn connect_info(&self) -> Peer {
        self.peer.clone()
    }
}
impl AsyncRead for Connection {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_read(cx, buf)
    }
}
impl AsyncWrite for Connection {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, buf)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

pub fn incoming(
    listener: TcpListener,
    config: Arc<rustls::ServerConfig>,
) -> impl Stream<Item = io::Result<Connection>> {
    let acceptor = TlsAcceptor::from(config);
    async_stream::stream! { loop { yield listener.accept().await.map(|(tcp,_)| tcp); } }
        .map(move |tcp| {
            let acceptor = acceptor.clone();
            async move {
                let tcp = match tcp {
                    Ok(tcp) => tcp,
                    Err(error) => return Some(Err(error)),
                };
                if tcp.set_nodelay(true).is_err() {
                    return None;
                }
                let stream = match timeout(Duration::from_secs(5), acceptor.accept(tcp)).await {
                    Ok(Ok(stream)) => stream,
                    _ => return None,
                };
                let id = stream
                    .get_ref()
                    .1
                    .peer_certificates()
                    .and_then(|certs| certs.first())
                    .and_then(|cert| spiffe::cert::spiffe_id_from_der(cert.as_ref()).ok())?;
                if !policy::allowed_workload(&id.to_string()) || id.to_string() == OFZ_ID {
                    return None;
                }
                Some(Ok(Connection {
                    stream,
                    peer: Peer(id.to_string()),
                }))
            }
        })
        .buffer_unordered(32)
        .filter_map(futures::future::ready)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn headers_cannot_forge_attested_caller_and_old_contracts_are_rejected() {
        let mut request = Request::new(());
        request
            .metadata_mut()
            .insert("x-spiffe-id", BFF_ID.parse().unwrap());
        request
            .metadata_mut()
            .insert("x-ofz-contract-version", "1".parse().unwrap());
        assert_eq!(
            peer(&request).unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
        request.extensions_mut().insert(Peer(BFF_ID.into()));
        assert_eq!(peer(&request).unwrap(), BFF_ID);
        request
            .metadata_mut()
            .insert("x-ofz-contract-version", "0".parse().unwrap());
        assert_eq!(
            peer(&request).unwrap_err().code(),
            tonic::Code::FailedPrecondition
        );
    }
}
