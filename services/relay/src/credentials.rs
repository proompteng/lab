use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tonic::Status;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Authentication {
    None,
    BearerFile { path: String },
    Oauth2 { profile: String },
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
            },
            "invalid connector authentication registration"
        );
        Ok(())
    }
    pub(crate) fn provider<'a>(&'a self, destination: &'a str) -> Option<Provider<'a>> {
        match self {
            Self::Oauth2 { profile } => Some(Provider {
                profile,
                destination,
            }),
            _ => None,
        }
    }
    pub(crate) async fn bearer(&self, provided: Option<&str>) -> Result<Option<String>, Status> {
        let token = match self {
            Self::None => return Ok(None),
            Self::BearerFile { path } => read_file(path).await?,
            Self::Oauth2 { .. } => provided
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
