use std::{
    env, io,
    net::SocketAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use anyhow::{Context as _, bail};
use base64::Engine as _;
use futures::{Stream, StreamExt};
use hyper_util::rt::TokioIo;
use spiffe::bundle::BundleSource as _;
use spiffe::{SpiffeId, TrustDomain, X509Source, X509Svid, x509_source::SvidPicker};
use spiffe_rustls::{LocalOnly, authorizer, mtls_client, mtls_server};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_rustls::{TlsAcceptor, TlsConnector};
use tonic::transport::{
    Channel, Endpoint,
    server::{Connected, TcpConnectInfo},
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PENDING_HANDSHAKES: usize = 32;

#[derive(Clone)]
pub enum WorkloadIdentity {
    Spiffe {
        source: X509Source,
        domain: TrustDomain,
    },
    #[cfg(test)]
    Fixture,
}

struct ExactIdentity(SpiffeId);

impl SvidPicker for ExactIdentity {
    fn pick_svid(&self, svids: &[Arc<X509Svid>]) -> Option<usize> {
        svids.iter().position(|svid| svid.spiffe_id() == &self.0)
    }
}

impl WorkloadIdentity {
    pub async fn from_environment(namespace: &str) -> anyhow::Result<Self> {
        let endpoint =
            env::var("SPIFFE_ENDPOINT_SOCKET").context("SPIFFE_ENDPOINT_SOCKET is required")?;
        if !endpoint.starts_with("unix:///") || endpoint.contains(['\0', '?', '#']) {
            bail!("SPIFFE Workload API requires an absolute Unix socket");
        }
        let domain: TrustDomain = env::var("SPIFFE_TRUST_DOMAIN")
            .context("SPIFFE_TRUST_DOMAIN is required")?
            .parse()
            .context("parse SPIFFE trust domain")?;
        Self::from_endpoint(endpoint, domain, namespace).await
    }

    pub async fn from_endpoint(
        endpoint: String,
        domain: TrustDomain,
        namespace: &str,
    ) -> anyhow::Result<Self> {
        let own_id: SpiffeId = format!("spiffe://{domain}/ns/{namespace}/sa/tengri").parse()?;
        let source = X509Source::builder()
            .endpoint(endpoint)
            .picker(ExactIdentity(own_id))
            .initial_sync_timeout(Duration::from_secs(30))
            .build()
            .await
            .context("obtain Tengri SPIFFE identity")?;
        Ok(Self::Spiffe { source, domain })
    }

    pub fn guest_id(&self, namespace: &str, pod_uid: &str) -> anyhow::Result<SpiffeId> {
        let domain = match self {
            Self::Spiffe { domain, .. } => domain.to_string(),
            #[cfg(test)]
            Self::Fixture => "proompteng.ai".to_owned(),
        };
        if pod_uid.is_empty()
            || !pod_uid
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            bail!("invalid guest Pod UID");
        }
        Ok(format!("spiffe://{domain}/ns/{namespace}/nanoagent/pod/{pod_uid}").parse()?)
    }

    pub fn guest_tls(&self, peer: SpiffeId) -> anyhow::Result<Option<Arc<rustls::ClientConfig>>> {
        match self {
            Self::Spiffe { source, domain } => Ok(Some(Arc::new(
                mtls_client(source.clone())
                    .authorize(authorizer::exact([peer])?)
                    .trust_domain_policy(LocalOnly(domain.clone()))
                    .with_alpn_protocols([b"h2".as_slice()])
                    .build()?,
            ))),
            #[cfg(test)]
            Self::Fixture => Ok(None),
        }
    }

    pub fn guest_channel(
        &self,
        address: SocketAddr,
        tls: Option<Arc<rustls::ClientConfig>>,
    ) -> anyhow::Result<Channel> {
        #[cfg(test)]
        if matches!(self, Self::Fixture) {
            return Ok(Endpoint::from_shared(format!("http://{address}"))?.connect_lazy());
        }
        let tls = tls.context("Nanoagent requires SPIFFE mutual TLS")?;
        let connector = TlsConnector::from(tls);
        let name = rustls::pki_types::ServerName::IpAddress(address.ip().into());
        Ok(Endpoint::from_shared(format!("https://{address}"))?
            .connect_timeout(HANDSHAKE_TIMEOUT)
            .connect_with_connector_lazy(tower::service_fn(move |_| {
                let connector = connector.clone();
                let name = name.clone();
                async move {
                    let tcp = TcpStream::connect(address).await?;
                    tcp.set_nodelay(true)?;
                    Ok::<_, io::Error>(TokioIo::new(connector.connect(name, tcp).await?))
                }
            })))
    }

    pub fn bundle_pem(&self) -> anyhow::Result<Vec<u8>> {
        match self {
            Self::Spiffe { source, domain } => {
                let bundle = source
                    .bundle_for_trust_domain(domain)?
                    .context("SPIRE trust bundle is unavailable")?;
                let mut pem = String::new();
                for authority in bundle.authorities() {
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(authority.as_ref());
                    pem.push_str("-----BEGIN CERTIFICATE-----\n");
                    for chunk in encoded.as_bytes().chunks(64) {
                        pem.push_str(std::str::from_utf8(chunk)?);
                        pem.push('\n');
                    }
                    pem.push_str("-----END CERTIFICATE-----\n");
                }
                Ok(pem.into_bytes())
            }
            #[cfg(test)]
            Self::Fixture => bail!("fixture identity has no production bundle"),
        }
    }

    pub fn server_tls(&self) -> anyhow::Result<Arc<rustls::ServerConfig>> {
        match self {
            Self::Spiffe { source, domain } => {
                let peer: SpiffeId =
                    format!("spiffe://{domain}/ns/proompteng/sa/proompteng").parse()?;
                Ok(Arc::new(
                    mtls_server(source.clone())
                        .authorize(authorizer::exact([peer])?)
                        .trust_domain_policy(LocalOnly(domain.clone()))
                        .with_alpn_protocols([b"h2"])
                        .build()?,
                ))
            }
            #[cfg(test)]
            Self::Fixture => bail!("fixture identity cannot serve the production control plane"),
        }
    }
}

pub struct TlsConnection(tokio_rustls::server::TlsStream<TcpStream>);

impl Connected for TlsConnection {
    type ConnectInfo = TcpConnectInfo;
    fn connect_info(&self) -> Self::ConnectInfo {
        self.0.get_ref().0.connect_info()
    }
}

impl AsyncRead for TlsConnection {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl AsyncWrite for TlsConnection {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

pub fn tls_incoming(
    listener: TcpListener,
    tls: Arc<rustls::ServerConfig>,
) -> impl Stream<Item = io::Result<TlsConnection>> {
    let acceptor = TlsAcceptor::from(tls);
    async_stream::stream! {
        loop {
            yield listener.accept().await.map(|(stream, _)| stream);
        }
    }
    .map(move |connection| {
        let acceptor = acceptor.clone();
        async move {
            match connection {
                Ok(stream) => match timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                    Ok(Ok(stream)) => Some(Ok(TlsConnection(stream))),
                    Ok(Err(_)) | Err(_) => None,
                },
                Err(error) => Some(Err(error)),
            }
        }
    })
    .buffer_unordered(MAX_PENDING_HANDSHAKES)
    .filter_map(futures::future::ready)
}
