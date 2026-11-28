use futures::StreamExt;
use serde::Deserialize;
use std::{collections::BTreeSet, path::Path, time::Duration};
use tokio::{sync::Mutex, time::Instant};
use tonic::Status;

const ACCESS_TOKEN: &str = "urn:ietf:params:oauth:token-type:access_token";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub spiffe_id: String,
    pub audience: String,
    pub token_endpoint: String,
    pub scopes: Vec<String>,
    pub ca_file: Option<String>,
}

impl Registration {
    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        let endpoint = reqwest::Url::parse(&self.token_endpoint)?;
        platform_client::jwt::Identity::new(
            "unix:///validation.sock".into(),
            &self.spiffe_id,
            self.audience.clone(),
        )?;
        anyhow::ensure!(
            self.token_endpoint.len() <= 2048
                && !self.token_endpoint.chars().any(char::is_control)
                && endpoint.scheme() == "https"
                && endpoint.host_str().is_some()
                && endpoint.username().is_empty()
                && endpoint.password().is_none()
                && endpoint.query().is_none()
                && endpoint.fragment().is_none()
                && self
                    .ca_file
                    .as_ref()
                    .is_none_or(|path| Path::new(path).is_absolute())
                && (1..=32).contains(&self.scopes.len()),
            "invalid federation registration"
        );
        let mut scopes = BTreeSet::new();
        anyhow::ensure!(
            self.scopes.iter().all(|scope| {
                !scope.is_empty()
                    && scope.len() <= 256
                    && scopes.insert(scope)
                    && scope.bytes().all(|b| {
                        b == 0x21 || (0x23..=0x5b).contains(&b) || (0x5d..=0x7e).contains(&b)
                    })
            }),
            "invalid federation scopes"
        );
        Ok(())
    }
}

pub(crate) struct Federation {
    registration: Registration,
    identity: platform_client::jwt::Identity,
    client: reqwest::Client,
    cached: Mutex<Option<Token>>,
}

struct Token {
    value: String,
    refresh_at: Instant,
}

#[derive(Deserialize)]
struct Response {
    access_token: String,
    issued_token_type: String,
    token_type: String,
    expires_in: u64,
    scope: Option<String>,
}

impl Federation {
    pub(crate) fn new(registration: Registration) -> anyhow::Result<Self> {
        registration.validate()?;
        let identity = platform_client::jwt::Identity::new(
            std::env::var("SPIFFE_ENDPOINT_SOCKET")?,
            &registration.spiffe_id,
            registration.audience.clone(),
        )?;
        Ok(Self {
            client: crate::http::client(registration.ca_file.as_deref())?,
            registration,
            identity,
            cached: Mutex::new(None),
        })
    }

    pub(crate) async fn bearer(&self) -> Result<String, Status> {
        tokio::time::timeout(Duration::from_secs(10), self.exchange())
            .await
            .map_err(|_| Status::unavailable("workload federation deadline"))?
    }

    async fn exchange(&self) -> Result<String, Status> {
        // One owner refreshes each registration; failed renewal never serves a stale credential.
        let mut cached = self.cached.lock().await;
        if let Some(token) = cached
            .as_ref()
            .filter(|token| Instant::now() < token.refresh_at)
        {
            return Ok(token.value.clone());
        }
        *cached = None;
        let subject = self
            .identity
            .token()
            .await
            .map_err(|_| Status::unavailable("workload identity unavailable"))?;
        let started = Instant::now();
        let scopes = self.registration.scopes.join(" ");
        let response = self
            .client
            .post(&self.registration.token_endpoint)
            .form(&[
                (
                    "grant_type",
                    "urn:ietf:params:oauth:grant-type:token-exchange",
                ),
                ("requested_token_type", ACCESS_TOKEN),
                ("subject_token_type", "urn:ietf:params:oauth:token-type:jwt"),
                ("subject_token", subject.as_str()),
                ("audience", self.registration.audience.as_str()),
                ("scope", scopes.as_str()),
            ])
            .send()
            .await
            .map_err(|_| Status::unavailable("workload token exchange unavailable"))?;
        if !response.status().is_success() {
            return Err(Status::unavailable("workload token exchange rejected"));
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| Status::unavailable("workload token response unavailable"))?;
            if body.len() + chunk.len() > 32_768 {
                return Err(Status::unavailable(
                    "workload token response exceeds its byte budget",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        let response: Response = serde_json::from_slice(&body)
            .map_err(|_| Status::unavailable("invalid workload token response"))?;
        if response.issued_token_type != ACCESS_TOKEN
            || !response.token_type.eq_ignore_ascii_case("Bearer")
            || !(1..=86_400).contains(&response.expires_in)
            || response.access_token.is_empty()
            || response.access_token.len() > 16_384
            || !response.access_token.bytes().all(|b| b.is_ascii_graphic())
            || response.scope.as_ref().is_some_and(|scope| {
                scope.split(' ').collect::<BTreeSet<_>>()
                    != self
                        .registration
                        .scopes
                        .iter()
                        .map(String::as_str)
                        .collect()
            })
        {
            return Err(Status::unavailable("invalid workload token response"));
        }
        let lifetime = Duration::from_secs(response.expires_in);
        let refresh_at = started + lifetime - (lifetime / 10).min(Duration::from_secs(30));
        if refresh_at <= Instant::now() {
            return Err(Status::unavailable(
                "workload token already requires renewal",
            ));
        }
        let value = response.access_token;
        *cached = Some(Token {
            value: value.clone(),
            refresh_at,
        });
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration() -> Registration {
        Registration {
            spiffe_id: "spiffe://proompteng.ai/ns/relay/sa/relay".into(),
            audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/test/providers/spire".into(),
            token_endpoint: "https://sts.googleapis.com/v1/token".into(),
            scopes: vec!["https://www.googleapis.com/auth/cloud-platform.read-only".into()],
            ca_file: None,
        }
    }

    #[test]
    fn refuses_unsafe_exchange_destinations() {
        assert!(registration().validate().is_ok());
        for endpoint in [
            "http://sts.googleapis.com/v1/token",
            "https://user:secret@example.com/token",
            "https://example.com/token?scope=write",
            "https://example.com/token#ignored",
            "https://example.com/\ntoken",
        ] {
            let mut registration = registration();
            registration.token_endpoint = endpoint.into();
            assert!(registration.validate().is_err(), "accepted {endpoint}");
        }
    }

    #[test]
    fn refuses_ambiguous_identity_scope_and_trust_configuration() {
        let mut value = registration();
        value.spiffe_id = "https://proompteng.ai/relay".into();
        assert!(value.validate().is_err());
        for audience in ["", "audience another", "audience\n"] {
            let mut value = registration();
            value.audience = audience.into();
            assert!(value.validate().is_err());
        }
        for scopes in [
            vec![],
            vec!["read write"],
            vec!["read", "read"],
            vec!["read\n"],
        ] {
            let mut value = registration();
            value.scopes = scopes.into_iter().map(str::to_owned).collect();
            assert!(value.validate().is_err());
        }
        let mut value = registration();
        value.ca_file = Some("relative.pem".into());
        assert!(value.validate().is_err());
    }
}
