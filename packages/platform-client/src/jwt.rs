use anyhow::{Context, ensure};
use spiffe::{SpiffeId, WorkloadApiClient};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A fixed identity and audience fetched from the local, attesting SPIRE agent.
pub struct Identity {
    endpoint: String,
    subject: SpiffeId,
    audience: String,
}

impl Identity {
    pub fn new(endpoint: String, subject: &str, audience: String) -> anyhow::Result<Self> {
        ensure!(
            endpoint.starts_with("unix:///") && !endpoint.contains(['\0', '?', '#']),
            "absolute SPIFFE Unix socket required"
        );
        ensure!(
            !audience.is_empty()
                && audience.len() <= 2048
                && !audience.chars().any(char::is_whitespace)
                && !audience.chars().any(char::is_control),
            "invalid JWT audience"
        );
        Ok(Self {
            endpoint,
            subject: subject.parse()?,
            audience,
        })
    }

    pub async fn token(&self) -> anyhow::Result<String> {
        tokio::time::timeout(Duration::from_secs(5), async {
            let client = WorkloadApiClient::connect_to(&self.endpoint)
                .await
                .context("connect to JWT Workload API")?;
            let svid = client
                .fetch_jwt_svid([&self.audience], Some(&self.subject))
                .await
                .context("fetch JWT-SVID")?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            ensure!(
                svid.spiffe_id() == &self.subject
                    && svid.audience() == [self.audience.as_str()]
                    && svid.expiry().unix_timestamp() > i64::try_from(now)? + 5
                    && svid.token().len() <= 16_384,
                "JWT-SVID does not match its registration or is expiring"
            );
            client
                .validate_jwt_token(&self.audience, svid.token())
                .await
                .context("validate JWT-SVID with the attesting agent")?;
            Ok(svid.token().to_owned())
        })
        .await
        .context("JWT Workload API deadline")?
    }
}
