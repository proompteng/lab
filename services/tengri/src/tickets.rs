use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use rand::distr::{Alphanumeric, SampleString};
use sha2::Sha256;
use tonic::Status;

const TICKET_LIFETIME: Duration = Duration::from_secs(30);
const PREVIEW_SESSION_LIFETIME: Duration = Duration::from_secs(30 * 60);
const PENDING_TICKET_LIMIT: usize = 128;
const PENDING_TICKET_LIMIT_PER_AGENT: usize = 16;
const PREVIEW_SESSION_LIMIT: usize = 96;
const PREVIEW_SESSION_LIMIT_PER_AGENT: usize = 16;

#[derive(Clone, Debug)]
pub enum TicketScope {
    Terminal { terminal_id: String },
    Preview { port: u16, initial_path: String },
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
        anyhow::ensure!(
            public_url.starts_with("https://") || public_url.starts_with("http://localhost"),
            "TENGRI_PUBLIC_URL must use HTTPS outside localhost"
        );
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
        self.issue(
            owner_hash,
            agent_id,
            TicketScope::Terminal {
                terminal_id: terminal_id.to_owned(),
            },
            "/v1/terminal/ws",
            None,
        )
    }

    pub fn issue_preview(
        &self,
        owner_hash: &str,
        agent_id: &str,
        port: u16,
        initial_path: &str,
    ) -> Result<IssuedTicket, Status> {
        self.issue(
            owner_hash,
            agent_id,
            TicketScope::Preview {
                port,
                initial_path: initial_path.to_owned(),
            },
            "/v1/preview/open",
            Some('#'),
        )
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

    pub fn create_preview_session(
        &self,
        ticket: TicketRecord,
    ) -> Result<PreviewSessionRecord, Status> {
        let TicketScope::Preview { port, initial_path } = ticket.scope else {
            return Err(Status::permission_denied(
                "ticket is not scoped to a preview",
            ));
        };
        let session = PreviewSessionRecord {
            id: random_dns_label(24),
            token: self.signed_token(),
            owner_hash: ticket.owner_hash,
            agent_id: ticket.agent_id,
            port,
            initial_path,
            expires_at: SystemTime::now() + PREVIEW_SESSION_LIFETIME,
        };
        let mut previews = self
            .previews
            .lock()
            .map_err(|_| Status::internal("preview state is unavailable"))?;
        let now = SystemTime::now();
        previews.retain(|_, active| active.expires_at > now);
        if previews.len() >= PREVIEW_SESSION_LIMIT
            || previews
                .values()
                .filter(|active| active.agent_id == session.agent_id)
                .count()
                >= PREVIEW_SESSION_LIMIT_PER_AGENT
        {
            return Err(Status::resource_exhausted(
                "too many active preview sessions",
            ));
        }
        previews.insert(session.id.clone(), session.clone());
        Ok(session)
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
            .create_preview_session(store.consume(&ticket.token).expect("consume"))
            .expect("preview session");
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
            let ticket = previews
                .consume(&issued.token)
                .expect("consume preview ticket");
            previews
                .create_preview_session(ticket)
                .expect("preview within limit");
        }
        let issued = previews
            .issue_preview(&"a".repeat(64), "agent", 3000, "/")
            .expect("overflow preview ticket");
        let error = previews
            .create_preview_session(
                previews
                    .consume(&issued.token)
                    .expect("consume overflow ticket"),
            )
            .expect_err("preview session limit");
        assert_eq!(error.code(), tonic::Code::ResourceExhausted);
    }
}
