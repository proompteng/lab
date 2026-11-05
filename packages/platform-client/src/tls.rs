use anyhow::{Context as _, ensure};
use futures::{Stream, StreamExt};
use hyper_util::rt::TokioIo;
pub use spiffe::SpiffeId as SpiffeIdentity;
use spiffe::{SpiffeId, TrustDomain, X509Source, X509Svid, x509_source::SvidPicker};
use spiffe_rustls::{LocalOnly, authorizer, mtls_client, mtls_server};
use std::{
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tonic::{
    Status,
    transport::{Channel, Endpoint, server::Connected},
};

struct ExactIdentity(SpiffeId);
impl SvidPicker for ExactIdentity {
    fn pick_svid(&self, svids: &[Arc<X509Svid>]) -> Option<usize> {
        svids.iter().position(|s| s.spiffe_id() == &self.0)
    }
}
#[derive(Clone)]
pub struct Identity {
    source: X509Source,
}
impl Identity {
    pub async fn load(identity: &str) -> anyhow::Result<Self> {
        let endpoint =
            std::env::var("SPIFFE_ENDPOINT_SOCKET").context("SPIFFE_ENDPOINT_SOCKET required")?;
        ensure!(
            endpoint.starts_with("unix:///") && !endpoint.contains(['\0', '?', '#']),
            "absolute SPIFFE Unix socket required"
        );
        let source = X509Source::builder()
            .endpoint(endpoint)
            .picker(ExactIdentity(identity.parse()?))
            .initial_sync_timeout(Duration::from_secs(30))
            .build()
            .await?;
        Ok(Self { source })
    }
    pub fn channel(&self, authority: &str, peer: &str) -> anyhow::Result<Channel> {
        let url = reqwest::Url::parse(&format!("https://{authority}"))?;
        ensure!(
            url.host_str()
                .is_some_and(|host| host.parse::<std::net::IpAddr>().is_err())
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "fixed service DNS authority required"
        );
        let tls = mtls_client(self.source.clone())
            .authorize(authorizer::exact([peer.parse::<SpiffeId>()?])?)
            .trust_domain_policy(LocalOnly("proompteng.ai".parse::<TrustDomain>()?))
            .with_alpn_protocols([b"h2".as_slice()])
            .build()?;
        let connector = TlsConnector::from(Arc::new(tls));
        let address = format!(
            "{}:{}",
            url.host_str().unwrap(),
            url.port_or_known_default().unwrap()
        );
        let name = rustls::pki_types::ServerName::try_from(url.host_str().unwrap().to_owned())?;
        Ok(Endpoint::from_shared(url.to_string())?
            .connect_timeout(Duration::from_secs(5))
            .connect_with_connector_lazy(tower::service_fn(move |_| {
                let connector = connector.clone();
                let address = address.clone();
                let name = name.clone();
                async move {
                    timeout(Duration::from_secs(5), async {
                        let tcp = TcpStream::connect(address).await?;
                        tcp.set_nodelay(true)?;
                        Ok::<_, io::Error>(TokioIo::new(connector.connect(name, tcp).await?))
                    })
                    .await
                    .map_err(|_| {
                        io::Error::new(io::ErrorKind::TimedOut, "platform TLS handshake deadline")
                    })?
                }
            })))
    }
    pub fn server_config(
        &self,
        authorize: impl Fn(&SpiffeId) -> bool + Send + Sync + 'static,
    ) -> anyhow::Result<Arc<rustls::ServerConfig>> {
        Ok(Arc::new(
            mtls_server(self.source.clone())
                .authorize(authorize)
                .trust_domain_policy(LocalOnly("proompteng.ai".parse::<TrustDomain>()?))
                .with_alpn_protocols([b"h2".as_slice()])
                .build()?,
        ))
    }
}
#[derive(Clone, Debug)]
pub struct Peer(pub String);
pub fn peer<T>(request: &tonic::Request<T>) -> Result<String, Status> {
    if request
        .metadata()
        .get("x-ofz-contract-version")
        .and_then(|v| v.to_str().ok())
        != Some("1")
    {
        return Err(Status::failed_precondition("platform contract mismatch"));
    }
    request
        .extensions()
        .get::<Peer>()
        .map(|p| p.0.clone())
        .ok_or_else(|| Status::unauthenticated("attested caller required"))
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
    tls: Arc<rustls::ServerConfig>,
) -> impl Stream<Item = io::Result<Connection>> {
    let acceptor = TlsAcceptor::from(tls);
    async_stream::stream! {loop {yield listener.accept().await.map(|(stream,_)|stream);}}
        .map(move |connection| {
            let acceptor = acceptor.clone();
            async move {
                let tcp = match connection {
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
                    .and_then(|certificates| certificates.first())
                    .and_then(|certificate| {
                        spiffe::cert::spiffe_id_from_der(certificate.as_ref()).ok()
                    })?;
                Some(Ok(Connection {
                    stream,
                    peer: Peer(id.to_string()),
                }))
            }
        })
        .buffer_unordered(32)
        .filter_map(futures::future::ready)
}
