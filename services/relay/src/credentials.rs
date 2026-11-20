use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tonic::Status;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Authentication {
    None,
    BearerFile {
        path: String,
    },
    Oauth2 {
        profile: String,
    },
    SpiffeJwt {
        audience: String,
    },
    WorkloadIdentity {
        federation: crate::federation::Registration,
    },
}

pub struct Provider<'a> {
    pub profile: &'a str,
    pub destination: &'a str,
}

impl Authentication {
    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            match self {
                Self::None => true,
                Self::BearerFile { path } => std::path::Path::new(path).is_absolute(),
                Self::Oauth2 { profile } => crate::config::identifier(profile),
                Self::SpiffeJwt { audience } => reqwest::Url::parse(audience).is_ok_and(|url| {
                    url.scheme() == "https"
                        && url.host_str().is_some()
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.query().is_none()
                        && url.fragment().is_none()
                }),
                Self::WorkloadIdentity { federation } => {
                    federation.validate()?;
                    true
                }
            },
            "invalid connector authentication registration"
        );
        Ok(())
    }
}

pub(crate) enum Credentials {
    None,
    BearerFile(String),
    Oauth2(String),
    WorkloadIdentity(Box<crate::federation::Federation>),
    SpiffeJwt(platform_client::jwt::Identity),
}

impl Credentials {
    pub(crate) fn new(authentication: Authentication) -> anyhow::Result<Self> {
        authentication.validate()?;
        Ok(match authentication {
            Authentication::None => Self::None,
            Authentication::BearerFile { path } => Self::BearerFile(path),
            Authentication::Oauth2 { profile } => Self::Oauth2(profile),
            Authentication::SpiffeJwt { audience } => {
                Self::SpiffeJwt(platform_client::jwt::Identity::new(
                    std::env::var("SPIFFE_ENDPOINT_SOCKET")?,
                    "spiffe://proompteng.ai/ns/relay/sa/relay",
                    audience,
                )?)
            }
            Authentication::WorkloadIdentity { federation } => {
                Self::WorkloadIdentity(Box::new(crate::federation::Federation::new(federation)?))
            }
        })
    }
    pub(crate) fn provider<'a>(&'a self, destination: &'a str) -> Option<Provider<'a>> {
        match self {
            Self::Oauth2(profile) => Some(Provider {
                profile,
                destination,
            }),
            _ => None,
        }
    }
    pub(crate) async fn bearer(&self, provided: Option<&str>) -> Result<Option<String>, Status> {
        let token = match self {
            Self::None => return Ok(None),
            Self::BearerFile(path) => read_file(path).await?,
            Self::WorkloadIdentity(federation) => federation.bearer().await?,
            Self::SpiffeJwt(identity) => identity
                .token()
                .await
                .map_err(|_| Status::unavailable("Relay workload credential unavailable"))?,
            Self::Oauth2(_) => provided
                .ok_or_else(|| {
                    Status::failed_precondition(
                        "connect the provider account before using this tool",
                    )
                })?
                .to_owned(),
        };
        if token.is_empty() || token.len() > 16_384 || token.chars().any(char::is_control) {
            return Err(Status::unavailable("invalid provider credential"));
        }
        Ok(Some(token))
    }
}

pub(crate) async fn read_file(path: &str) -> Result<String, Status> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| Status::unavailable("provider credential unavailable"))?;
    let mut value = String::new();
    file.take(16_385)
        .read_to_string(&mut value)
        .await
        .map_err(|_| Status::unavailable("invalid provider credential"))?;
    if value.len() > 16_384 || value.contains('\0') || value.trim_end().is_empty() {
        return Err(Status::unavailable("invalid provider credential"));
    }
    Ok(value.trim_end().into())
}
