use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use http::Uri;
use rand::distr::{Alphanumeric, SampleString};
use sha2::Sha256;
use tonic::Status;

const TICKET_LIFETIME: Duration = Duration::from_secs(30);
const PREVIEW_SESSION_LIFETIME: Duration = Duration::from_secs(30 * 60);
const PENDING_TICKET_LIMIT: usize = 128;
const PENDING_TICKET_LIMIT_PER_AGENT: usize = 16;
const PREVIEW_SESSION_LIMIT: usize = 96;
const PREVIEW_SESSION_LIMIT_PER_AGENT: usize = 16;
const PREVIEW_SESSION_LABEL_LENGTH: usize = 24;

#[derive(Clone, Debug)]
pub enum TicketScope {
    Terminal {
        terminal_id: String,
    },
    Preview {
        session_id: String,
        port: u16,
        initial_path: String,
    },
}

#[derive(Clone, Debug)]
pub struct TicketRecord {
    pub owner_hash: String,
    pub agent_id: String,
    pub scope: TicketScope,
    expires_at: SystemTime,
}

#[derive(Clone, Debug)]
pub struct PreviewSessionRecord {
    pub id: String,
    pub token: String,
    pub owner_hash: String,
    pub agent_id: String,
    pub port: u16,
    pub initial_path: String,
    pub expires_at: SystemTime,
}

#[derive(Clone)]
pub struct TicketStore {
    public_url: Arc<str>,
    signing_secret: Arc<[u8]>,
    tickets: Arc<Mutex<HashMap<String, TicketRecord>>>,
    previews: Arc<Mutex<HashMap<String, PreviewSessionRecord>>>,
}

#[derive(Debug)]
pub struct IssuedTicket {
    pub id: String,
    pub token: String,
    pub url: String,
    pub expires_at: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TicketStats {
    pub pending: usize,
    pub previews: usize,
}

impl TicketStore {
    pub fn new(public_url: String, signing_secret: String) -> anyhow::Result<Self> {
        let public_url = public_url.trim_end_matches('/');
        validate_public_url(public_url)?;
        anyhow::ensure!(
            signing_secret.len() >= 32,
            "TENGRI_TICKET_SIGNING_SECRET must contain at least 32 bytes"
        );
        Ok(Self {
            public_url: Arc::from(public_url.to_owned()),
            signing_secret: Arc::from(signing_secret.into_bytes()),
            tickets: Arc::new(Mutex::new(HashMap::new())),
            previews: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn issue_terminal(
        &self,
        owner_hash: &str,
        agent_id: &str,
        terminal_id: &str,
    ) -> Result<IssuedTicket, Status> {
        let mut issued = self.issue(
            owner_hash,
            agent_id,
            TicketScope::Terminal {
                terminal_id: terminal_id.to_owned(),
            },
            "/v1/terminal/ws",
            None,
        )?;
        issued.url = websocket_url(&issued.url)?;
        Ok(issued)
    }

    pub fn issue_preview(
        &self,
        owner_hash: &str,
        agent_id: &str,
        port: u16,
        initial_path: &str,
    ) -> Result<IssuedTicket, Status> {
        let session_id = random_dns_label(PREVIEW_SESSION_LABEL_LENGTH);
        let mut issued = self.issue(
            owner_hash,
            agent_id,
            TicketScope::Preview {
                session_id: session_id.clone(),
                port,
                initial_path: initial_path.to_owned(),
            },
            "/v1/preview/open",
            Some('#'),
        )?;
        issued.id = session_id;
        Ok(issued)
    }

    pub fn consume(&self, token: &str) -> Result<TicketRecord, Status> {
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| Status::internal("ticket state is unavailable"))?;
        tickets.retain(|_, ticket| ticket.expires_at > SystemTime::now());
        let ticket = tickets.remove(token).ok_or_else(|| {
            Status::unauthenticated("ticket is invalid, expired, or already used")
        })?;
        if ticket.expires_at <= SystemTime::now() {
            return Err(Status::unauthenticated("ticket expired"));
        }
        Ok(ticket)
    }

    pub fn consume_preview(&self, token: &str) -> Result<PreviewSessionRecord, Status> {
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| Status::internal("ticket state is unavailable"))?;
        let now = SystemTime::now();
        tickets.retain(|_, ticket| ticket.expires_at > now);
        let ticket = tickets.get(token).cloned().ok_or_else(|| {
            Status::unauthenticated("ticket is invalid, expired, or already used")
        })?;
        let TicketScope::Preview {
            session_id,
            port,
            initial_path,
        } = ticket.scope
        else {
            return Err(Status::permission_denied(
                "ticket is not scoped to a preview",
            ));
        };
        let mut previews = self
            .previews
            .lock()
            .map_err(|_| Status::internal("preview state is unavailable"))?;
        previews.retain(|_, active| active.expires_at > now);
        if previews.len() >= PREVIEW_SESSION_LIMIT
            || previews
                .values()
                .filter(|active| active.agent_id == ticket.agent_id)
                .count()
                >= PREVIEW_SESSION_LIMIT_PER_AGENT
        {
            tickets.remove(token);
            return Err(Status::resource_exhausted(
                "too many active preview sessions",
            ));
        }
        tickets.remove(token);
        let session = PreviewSessionRecord {
            id: session_id,
            token: self.signed_token(),
            owner_hash: ticket.owner_hash,
            agent_id: ticket.agent_id,
            port,
            initial_path,
            expires_at: SystemTime::now() + PREVIEW_SESSION_LIFETIME,
        };
        previews.insert(session.id.clone(), session.clone());
        Ok(session)
    }

    pub fn revoke_preview(
        &self,
        owner_hash: &str,
        agent_id: &str,
        session_id: &str,
    ) -> Result<(), Status> {
        self.tickets
            .lock()
            .map_err(|_| Status::internal("ticket state is unavailable"))?
            .retain(|_, ticket| {
                !(ticket.owner_hash == owner_hash
                    && ticket.agent_id == agent_id
                    && matches!(
                        &ticket.scope,
                        TicketScope::Preview {
                            session_id: pending_id,
                            ..
                        } if pending_id == session_id
                    ))
            });
        self.previews
            .lock()
            .map_err(|_| Status::internal("preview state is unavailable"))?
            .retain(|id, session| {
                !(id == session_id
                    && session.owner_hash == owner_hash
                    && session.agent_id == agent_id)
            });
        Ok(())
    }

    pub fn preview_session(&self, id: &str, token: &str) -> Result<PreviewSessionRecord, Status> {
        let mut previews = self
            .previews
            .lock()
            .map_err(|_| Status::internal("preview state is unavailable"))?;
        previews.retain(|_, session| session.expires_at > SystemTime::now());
        let session = previews
            .get(id)
            .filter(|session| constant_time_eq(session.token.as_bytes(), token.as_bytes()))
            .cloned()
            .ok_or_else(|| Status::unauthenticated("preview session is invalid or expired"))?;
        if session.owner_hash.len() != 64
            || !session
                .owner_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(Status::internal("preview session owner is invalid"));
        }
        Ok(session)
    }

    pub fn stats(&self) -> Result<TicketStats, Status> {
        let now = SystemTime::now();
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| Status::internal("ticket state is unavailable"))?;
        tickets.retain(|_, ticket| ticket.expires_at > now);
        let mut previews = self
            .previews
            .lock()
            .map_err(|_| Status::internal("preview state is unavailable"))?;
        previews.retain(|_, session| session.expires_at > now);
        Ok(TicketStats {
            pending: tickets.len(),
            previews: previews.len(),
        })
    }

    pub fn remove_agent(&self, agent_id: &str) -> Result<(), Status> {
        self.tickets
            .lock()
            .map_err(|_| Status::internal("ticket state is unavailable"))?
            .retain(|_, ticket| ticket.agent_id != agent_id);
        self.previews
            .lock()
            .map_err(|_| Status::internal("preview state is unavailable"))?
            .retain(|_, session| session.agent_id != agent_id);
        Ok(())
    }

    fn issue(
        &self,
        owner_hash: &str,
        agent_id: &str,
        scope: TicketScope,
        path: &str,
        token_separator: Option<char>,
    ) -> Result<IssuedTicket, Status> {
        let token = self.signed_token();
        let expires_at = SystemTime::now() + TICKET_LIFETIME;
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| Status::internal("ticket state is unavailable"))?;
        let now = SystemTime::now();
        tickets.retain(|_, ticket| ticket.expires_at > now);
        if tickets.len() >= PENDING_TICKET_LIMIT
            || tickets
                .values()
                .filter(|ticket| ticket.agent_id == agent_id)
                .count()
                >= PENDING_TICKET_LIMIT_PER_AGENT
        {
            return Err(Status::resource_exhausted(
                "too many pending one-use tickets",
            ));
        }
        tickets.insert(
            token.clone(),
            TicketRecord {
                owner_hash: owner_hash.to_owned(),
                agent_id: agent_id.to_owned(),
                scope,
                expires_at,
            },
        );
        Ok(IssuedTicket {
            id: token.clone(),
            url: token_separator.map_or_else(
                || format!("{}{path}", self.public_url),
                |separator| format!("{}{path}{separator}{token}", self.public_url),
            ),
            token,
            expires_at: DateTime::<Utc>::from(expires_at).to_rfc3339(),
        })
    }

    fn signed_token(&self) -> String {
        let nonce = random_token(48);
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.signing_secret)
            .expect("validated HMAC signing secret");
        mac.update(nonce.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{nonce}.{signature}")
    }
}

fn random_token(length: usize) -> String {
    Alphanumeric.sample_string(&mut rand::rng(), length)
}

fn random_dns_label(length: usize) -> String {
    random_token(length).to_ascii_lowercase()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn websocket_url(public_url: &str) -> Result<String, Status> {
    let uri = public_url
        .parse::<Uri>()
        .map_err(|_| Status::internal("terminal WebSocket URL is invalid"))?;
    match uri.scheme_str() {
        Some("https") => Ok(public_url.replacen("https://", "wss://", 1)),
        Some("http") if uri.host() == Some("localhost") => {
            Ok(public_url.replacen("http://", "ws://", 1))
        }
        _ => Err(Status::internal("terminal WebSocket URL is invalid")),
    }
}

fn validate_public_url(public_url: &str) -> anyhow::Result<()> {
    let uri = public_url
        .parse::<Uri>()
        .map_err(|error| anyhow::anyhow!("TENGRI_PUBLIC_URL is invalid: {error}"))?;
    anyhow::ensure!(
        uri.authority().is_some() && uri.host().is_some(),
        "TENGRI_PUBLIC_URL must be an absolute URL"
    );
    anyhow::ensure!(
        uri.path() == "/" && uri.query().is_none(),
        "TENGRI_PUBLIC_URL must not include a path or query"
    );
    anyhow::ensure!(
        uri.scheme_str() == Some("https")
            || (uri.scheme_str() == Some("http") && uri.host() == Some("localhost")),
        "TENGRI_PUBLIC_URL must use HTTPS outside localhost"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tickets_are_single_use_and_scope_preserving() {
        let store =
            TicketStore::new("https://tengri.example".to_owned(), "s".repeat(32)).expect("store");
        let issued = store
            .issue_terminal("owner", "agent", "terminal")
            .expect("ticket");
        let ticket = store.consume(&issued.token).expect("consume");
        assert!(matches!(
            ticket.scope,
            TicketScope::Terminal { ref terminal_id } if terminal_id == "terminal"
        ));
        assert!(store.consume(&issued.token).is_err());
        assert_eq!(issued.token.split('.').count(), 2);
        assert!(!issued.url.contains(&issued.token));
        assert_eq!(issued.url, "wss://tengri.example/v1/terminal/ws");
    }

    #[test]
    fn localhost_terminal_tickets_use_plain_websockets() {
        let store =
            TicketStore::new("http://localhost:8080".to_owned(), "s".repeat(32)).expect("store");
        let issued = store
            .issue_terminal("owner", "agent", "terminal")
            .expect("ticket");

        assert_eq!(issued.url, "ws://localhost:8080/v1/terminal/ws");
    }

    #[test]
    fn localhost_http_exception_requires_an_exact_hostname() {
        for invalid in [
            "http://localhost.attacker.example",
            "http://127.0.0.1:8080",
            "http://[::1]:8080",
            "https://tengri.example/base",
            "https://tengri.example/?query=1",
        ] {
            assert!(
                TicketStore::new(invalid.to_owned(), "s".repeat(32)).is_err(),
                "accepted invalid public URL {invalid}",
            );
        }
    }

    #[test]
    fn removing_an_agent_revokes_terminal_and_preview_capabilities() {
        let store =
            TicketStore::new("https://tengri.example".to_owned(), "s".repeat(32)).expect("store");
        let terminal = store
            .issue_terminal("owner", "agent-a", "terminal")
            .expect("terminal ticket");
        let preview = store
            .issue_preview("owner", "agent-a", 3000, "/")
            .expect("preview ticket");
        let other = store
            .issue_terminal("owner", "agent-b", "terminal")
            .expect("other ticket");

        store.remove_agent("agent-a").expect("revoke agent");

        assert!(store.consume(&terminal.token).is_err());
        assert!(store.consume(&preview.token).is_err());
        assert!(store.consume(&other.token).is_ok());
    }

    #[test]
    fn preview_session_ids_are_dns_safe() {
        let store =
            TicketStore::new("https://tengri.example".to_owned(), "s".repeat(32)).expect("store");
        let ticket = store
            .issue_preview(&"a".repeat(64), "agent", 3000, "/dashboard?mode=dev")
            .expect("preview ticket");
        let launch = reqwest::Url::parse(&ticket.url).expect("preview launch URL");
        assert_eq!(launch.query(), None);
        assert_eq!(launch.fragment(), Some(ticket.token.as_str()));
        let session = store
            .consume_preview(&ticket.token)
            .expect("preview session");
        assert_eq!(session.id, ticket.id);
        assert_eq!(session.id.len(), 24);
        assert_eq!(session.initial_path, "/dashboard?mode=dev");
        assert!(
            session
                .id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        );
    }

    #[test]
    fn preview_revocation_is_owner_scoped_and_clears_pending_and_active_sessions() {
        let owner = "a".repeat(64);
        let store =
            TicketStore::new("https://tengri.example".to_owned(), "s".repeat(32)).expect("store");
        let pending = store
            .issue_preview(&owner, "agent", 3000, "/pending")
            .expect("pending preview");
        store
            .revoke_preview("different-owner", "agent", &pending.id)
            .expect("wrong-owner revoke is idempotent");
        let pending_session = store
            .consume_preview(&pending.token)
            .expect("wrong owner did not revoke preview");
        store
            .revoke_preview(&owner, "agent", &pending_session.id)
            .expect("clean up wrong-owner proof");

        let active = store
            .issue_preview(&owner, "agent", 3000, "/active")
            .expect("active preview");
        let session = store
            .consume_preview(&active.token)
            .expect("create active preview");
        assert_eq!(store.stats().expect("stats").previews, 1);
        store
            .revoke_preview(&owner, "agent", &session.id)
            .expect("revoke active preview");
        assert_eq!(store.stats().expect("stats").previews, 0);
        assert!(store.preview_session(&session.id, &session.token).is_err());

        let pending = store
            .issue_preview(&owner, "agent", 3000, "/pending-again")
            .expect("pending preview again");
        store
            .revoke_preview(&owner, "agent", &pending.id)
            .expect("revoke pending preview");
        assert!(store.consume_preview(&pending.token).is_err());
    }

    #[test]
    fn preview_revocation_cannot_race_between_ticket_consumption_and_session_creation() {
        use std::sync::Barrier;

        let owner = "a".repeat(64);
        let store =
            TicketStore::new("https://tengri.example".to_owned(), "s".repeat(32)).expect("store");
        for _ in 0..100 {
            let issued = store
                .issue_preview(&owner, "agent", 3000, "/race")
                .expect("preview ticket");
            let barrier = Arc::new(Barrier::new(3));
            let consumed = std::thread::scope(|scope| {
                let consume_store = store.clone();
                let consume_barrier = barrier.clone();
                let token = issued.token.clone();
                let consume = scope.spawn(move || {
                    consume_barrier.wait();
                    consume_store.consume_preview(&token)
                });
                let revoke_store = store.clone();
                let revoke_barrier = barrier.clone();
                let session_id = issued.id.clone();
                let owner = owner.clone();
                let revoke = scope.spawn(move || {
                    revoke_barrier.wait();
                    revoke_store.revoke_preview(&owner, "agent", &session_id)
                });
                barrier.wait();
                let consumed = consume.join().expect("consume thread");
                revoke
                    .join()
                    .expect("revoke thread")
                    .expect("revoke preview");
                consumed
            });
            if let Ok(session) = consumed {
                assert!(store.preview_session(&session.id, &session.token).is_err());
            }
            assert_eq!(store.stats().expect("stats").previews, 0);
        }
    }

    #[test]
    fn ticket_and_preview_session_state_is_bounded_per_agent() {
        let store =
            TicketStore::new("https://tengri.example".to_owned(), "s".repeat(32)).expect("store");
        for index in 0..PENDING_TICKET_LIMIT_PER_AGENT {
            store
                .issue_terminal("owner", "agent", &format!("terminal-{index}"))
                .expect("ticket within limit");
        }
        let error = store
            .issue_terminal("owner", "agent", "one-too-many")
            .expect_err("pending ticket limit");
        assert_eq!(error.code(), tonic::Code::ResourceExhausted);
        assert!(
            store
                .issue_terminal("owner", "other-agent", "terminal")
                .is_ok()
        );

        let previews = TicketStore::new(
            "https://tengri.example".to_owned(),
            "different-signing-secret-1234567890".to_owned(),
        )
        .expect("preview store");
        for _ in 0..PREVIEW_SESSION_LIMIT_PER_AGENT {
            let issued = previews
                .issue_preview(&"a".repeat(64), "agent", 3000, "/")
                .expect("preview ticket");
            previews
                .consume_preview(&issued.token)
                .expect("preview within limit");
        }
        let issued = previews
            .issue_preview(&"a".repeat(64), "agent", 3000, "/")
            .expect("overflow preview ticket");
        let error = previews
            .consume_preview(&issued.token)
            .expect_err("preview session limit");
        assert_eq!(error.code(), tonic::Code::ResourceExhausted);
    }
}
