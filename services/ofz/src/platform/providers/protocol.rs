use std::{collections::BTreeSet, path::Path, time::Duration};

use futures::StreamExt;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointNotSet, EndpointSet,
    PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, RefreshToken, Scope, TokenResponse, TokenUrl,
    basic::{BasicClient, BasicTokenResponse, BasicTokenType},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tonic::Status;

use crate::{
    platform::{catalog, workspaces},
    proto, registry,
};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Ownership {
    Personal,
    Workspace,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Profile {
    pub id: String,
    pub name: String,
    pub workspace_id: String,
    pub connector_id: String,
    pub ownership: Ownership,
    pub resource: proto::PlatformResource,
    pub actions: Vec<String>,
    pub resource_url: String,
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub account_endpoint: String,
    pub account_id_field: String,
    pub account_name_field: String,
    pub revocation_endpoint: Option<String>,
    pub client_id: String,
    pub client_secret_file: Option<String>,
    pub ca_file: Option<String>,
    pub scopes: Vec<String>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Tokens {
    pub access: String,
    pub refresh: Option<String>,
    pub expires_at_ms: Option<u64>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Account {
    pub id: String,
    pub name: String,
}

type Client = BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;

pub(super) struct Protocol {
    pub profile: Profile,
    pub fingerprint: Vec<u8>,
    http: reqwest::Client,
}

fn https(value: &str) -> anyhow::Result<reqwest::Url> {
    anyhow::ensure!(
        value.len() <= 2048 && !value.chars().any(char::is_control),
        "invalid provider endpoint"
    );
    let url = reqwest::Url::parse(value)?;
    anyhow::ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "registered HTTPS provider endpoint required"
    );
    Ok(url)
}

impl Protocol {
    pub(super) fn new(profile: Profile) -> anyhow::Result<Self> {
        anyhow::ensure!(
            registry::identifier(&profile.id)
                && registry::identifier(&profile.connector_id)
                && !profile.name.trim().is_empty()
                && profile.name.len() <= 128
                && !profile.name.chars().any(char::is_control)
                && !profile.client_id.is_empty()
                && profile.client_id.len() <= 256
                && !profile.client_id.chars().any(char::is_control)
                && (1..=32).contains(&profile.scopes.len()),
            "invalid provider profile"
        );
        workspaces::resource_scope(&profile.workspace_id, &profile.resource)?;
        let catalog = catalog::configured()?;
        anyhow::ensure!(
            catalog.resource(&profile.resource.kind)?.workspace_scoped
                && (1..=16).contains(&profile.actions.len()),
            "workspace provider scope required"
        );
        let mut actions = BTreeSet::new();
        for action in &profile.actions {
            anyhow::ensure!(
                catalog.action(action)?.resource_kind == profile.resource.kind
                    && actions.insert(action),
                "invalid provider action"
            );
        }
        for endpoint in [
            &profile.resource_url,
            &profile.issuer,
            &profile.authorization_endpoint,
            &profile.token_endpoint,
            &profile.account_endpoint,
        ]
        .into_iter()
        .chain(profile.revocation_endpoint.iter())
        {
            https(endpoint)?;
        }
        for path in profile
            .ca_file
            .iter()
            .chain(profile.client_secret_file.iter())
        {
            anyhow::ensure!(
                Path::new(path).is_absolute(),
                "absolute provider secret path required"
            );
        }
        for field in [&profile.account_id_field, &profile.account_name_field] {
            anyhow::ensure!(
                !field.is_empty()
                    && field.len() <= 64
                    && field
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)),
                "invalid account metadata field"
            );
        }
        let mut scopes = BTreeSet::new();
        for scope in &profile.scopes {
            anyhow::ensure!(
                !scope.is_empty()
                    && scope.len() <= 256
                    && scope
                        .bytes()
                        .all(|byte| (0x21..=0x7e).contains(&byte) && byte != b'"' && byte != b'\\')
                    && scopes.insert(scope),
                "invalid or repeated OAuth scope"
            );
        }
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10));
        if let Some(path) = &profile.ca_file {
            let pem = std::fs::read(path)?;
            anyhow::ensure!(pem.len() <= 131_072, "provider CA exceeds its byte budget");
            builder = builder.tls_certs_only([reqwest::Certificate::from_pem(&pem)?]);
        }
        let fingerprint = Sha256::digest(serde_json::to_vec(&profile)?).to_vec();
        Ok(Self {
            profile,
            fingerprint,
            http: builder.build()?,
        })
    }

    async fn client(&self, redirect: Option<&str>) -> Result<Client, Status> {
        let mut client = BasicClient::new(ClientId::new(self.profile.client_id.clone()))
            .set_auth_uri(
                AuthUrl::new(self.profile.authorization_endpoint.clone())
                    .map_err(|_| Status::internal("invalid registered provider"))?,
            )
            .set_token_uri(
                TokenUrl::new(self.profile.token_endpoint.clone())
                    .map_err(|_| Status::internal("invalid registered provider"))?,
            );
        if let Some(redirect) = redirect {
            https(redirect)
                .map_err(|_| Status::invalid_argument("registered provider callback required"))?;
            client = client.set_redirect_uri(
                RedirectUrl::new(redirect.into())
                    .map_err(|_| Status::invalid_argument("invalid provider callback"))?,
            );
        }
        if let Some(path) = &self.profile.client_secret_file {
            let bytes = tokio::fs::read(path)
                .await
                .map_err(|_| Status::unavailable("provider client credential unavailable"))?;
            if bytes.is_empty() || bytes.len() > 16_384 {
                return Err(Status::unavailable("invalid provider client credential"));
            }
            let secret = String::from_utf8(bytes)
                .map_err(|_| Status::unavailable("invalid provider client credential"))?;
            client = client.set_client_secret(ClientSecret::new(secret.trim_end().into()));
        }
        Ok(client)
    }

    pub(super) async fn authorize(
        &self,
        redirect: &str,
        state: String,
    ) -> Result<(String, String), Status> {
        let client = self.client(Some(redirect)).await?;
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let (url, _) = client
            .authorize_url(|| CsrfToken::new(state))
            .add_scopes(self.profile.scopes.iter().cloned().map(Scope::new))
            .add_extra_param("resource", self.profile.resource_url.as_str())
            .set_pkce_challenge(challenge)
            .url();
        Ok((url.into(), verifier.secret().clone()))
    }

    async fn send(
        &self,
        request: oauth2::HttpRequest,
    ) -> Result<oauth2::HttpResponse, std::io::Error> {
        let (parts, body) = request.into_parts();
        let response = self
            .http
            .request(parts.method, parts.uri.to_string())
            .headers(parts.headers)
            .body(body)
            .send()
            .await
            .map_err(|_| std::io::Error::other("provider transport failed"))?;
        let mut result = oauth2::http::Response::builder().status(response.status());
        *result
            .headers_mut()
            .ok_or_else(|| std::io::Error::other("invalid provider response"))? =
            response.headers().clone();
        let bytes = bounded(response, 65_536)
            .await
            .map_err(|_| std::io::Error::other("provider response exceeds its byte budget"))?;
        result
            .body(bytes)
            .map_err(|_| std::io::Error::other("invalid provider response"))
    }

    fn tokens(
        &self,
        response: BasicTokenResponse,
        now: u64,
        previous: Option<&Tokens>,
    ) -> Result<Tokens, Status> {
        let valid_secret = |value: &str| {
            !value.is_empty() && value.len() <= 16_384 && !value.chars().any(char::is_control)
        };
        if response.token_type() != &BasicTokenType::Bearer
            || !valid_secret(response.access_token().secret())
            || response
                .refresh_token()
                .is_some_and(|token| !valid_secret(token.secret()))
        {
            return Err(Status::failed_precondition(
                "provider returned invalid credentials",
            ));
        }
        if let Some(granted) = response.scopes() {
            let granted: BTreeSet<_> = granted.iter().map(|scope| scope.as_str()).collect();
            let required: BTreeSet<_> = self.profile.scopes.iter().map(String::as_str).collect();
            if granted != required {
                return Err(Status::failed_precondition(
                    "provider granted different scopes; reconnect with the requested access",
                ));
            }
        }
        let expires_at_ms = response
            .expires_in()
            .map(|duration| {
                duration
                    .as_millis()
                    .try_into()
                    .ok()
                    .and_then(|millis| now.checked_add(millis))
                    .ok_or_else(|| Status::failed_precondition("invalid provider expiry"))
            })
            .transpose()?;
        if expires_at_ms.is_some_and(|expiry| expiry <= now || expiry > i64::MAX as u64) {
            return Err(Status::failed_precondition(
                "provider credential already expired",
            ));
        }
        Ok(Tokens {
            access: response.access_token().secret().clone(),
            refresh: response
                .refresh_token()
                .map(|token| token.secret().clone())
                .or_else(|| previous.and_then(|tokens| tokens.refresh.clone())),
            expires_at_ms,
        })
    }

    pub(super) async fn exchange(
        &self,
        redirect: &str,
        code: String,
        verifier: String,
        now: u64,
    ) -> Result<Tokens, Status> {
        if code.is_empty() || code.len() > 8192 || code.chars().any(char::is_control) {
            return Err(Status::invalid_argument(
                "invalid provider authorization code",
            ));
        }
        let client = self.client(Some(redirect)).await?;
        let response = client
            .exchange_code(AuthorizationCode::new(code))
            .set_pkce_verifier(PkceCodeVerifier::new(verifier))
            .add_extra_param("resource", self.profile.resource_url.as_str())
            .request_async(self)
            .await
            .map_err(|_| {
                Status::failed_precondition(
                    "provider authorization was not confirmed; reconnect your account",
                )
            })?;
        self.tokens(response, now, None)
    }

    pub(super) async fn refresh(&self, previous: &Tokens, now: u64) -> Result<Tokens, Status> {
        let refresh = previous
            .refresh
            .as_ref()
            .ok_or_else(|| Status::failed_precondition("provider login is required again"))?;
        let client = self.client(None).await?;
        let response = client
            .exchange_refresh_token(&RefreshToken::new(refresh.clone()))
            .add_extra_param("resource", self.profile.resource_url.as_str())
            .request_async(self)
            .await
            .map_err(|_| {
                Status::failed_precondition(
                    "provider refresh was not confirmed; reconnect your account",
                )
            })?;
        self.tokens(response, now, Some(previous))
    }

    pub(super) async fn account(&self, token: &Tokens) -> Result<Account, Status> {
        let response = self
            .http
            .get(&self.profile.account_endpoint)
            .bearer_auth(&token.access)
            .send()
            .await
            .map_err(|_| Status::unavailable("provider account lookup failed"))?;
        if !response.status().is_success() {
            return Err(Status::failed_precondition(
                "provider account could not be verified",
            ));
        }
        let bytes = bounded(response, 16_384).await?;
        let json: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|_| Status::failed_precondition("invalid provider account response"))?;
        let id = match &json[&self.profile.account_id_field] {
            serde_json::Value::String(id) => id.clone(),
            serde_json::Value::Number(id) if id.is_u64() => id.to_string(),
            _ => {
                return Err(Status::failed_precondition(
                    "provider did not identify the connected account",
                ));
            }
        };
        let name = json[&self.profile.account_name_field]
            .as_str()
            .ok_or_else(|| {
                Status::failed_precondition("provider did not name the connected account")
            })?
            .to_owned();
        if [&id, &name].iter().any(|value| {
            value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control)
        }) {
            return Err(Status::failed_precondition(
                "invalid provider account identity",
            ));
        }
        Ok(Account { id, name })
    }

    pub(super) async fn revoke(&self, token: &Tokens) -> Result<(), Status> {
        use oauth2::{AccessToken, RevocationUrl, StandardRevocableToken};
        let endpoint = self.profile.revocation_endpoint.as_ref().ok_or_else(|| {
            Status::failed_precondition("provider does not support automatic revocation")
        })?;
        let client = self.client(None).await?.set_revocation_url(
            RevocationUrl::new(endpoint.clone())
                .map_err(|_| Status::internal("invalid provider revocation endpoint"))?,
        );
        let mut revoke = Vec::new();
        if let Some(refresh) = &token.refresh {
            revoke.push(StandardRevocableToken::RefreshToken(RefreshToken::new(
                refresh.clone(),
            )));
        }
        revoke.push(StandardRevocableToken::AccessToken(AccessToken::new(
            token.access.clone(),
        )));
        for token in revoke {
            client
                .revoke_token(token)
                .map_err(|_| Status::failed_precondition("provider revocation unavailable"))?
                .request_async(self)
                .await
                .map_err(|_| Status::unavailable("provider revocation was not confirmed"))?;
        }
        Ok(())
    }
}

async fn bounded(response: reqwest::Response, max: usize) -> Result<Vec<u8>, Status> {
    if response
        .content_length()
        .is_some_and(|length| length > max as u64)
    {
        return Err(Status::resource_exhausted(
            "provider response exceeds its byte budget",
        ));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Status::unavailable("provider response was interrupted"))?;
        if chunk.len() > max.saturating_sub(body.len()) {
            return Err(Status::resource_exhausted(
                "provider response exceeds its byte budget",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

impl<'a> oauth2::AsyncHttpClient<'a> for Protocol {
    type Error = std::io::Error;
    type Future = std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<oauth2::HttpResponse, Self::Error>> + Send + 'a,
        >,
    >;
    fn call(&'a self, request: oauth2::HttpRequest) -> Self::Future {
        Box::pin(self.send(request))
    }
}
