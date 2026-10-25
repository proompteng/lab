use platform_client::authz::RegisteredRelayClient;
use std::{
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
#[derive(Clone)]
pub struct Enrollment(Arc<RwLock<(Instant, Vec<RegisteredRelayClient>)>>);
impl Enrollment {
    pub fn new(clients: Vec<RegisteredRelayClient>) -> Self {
        Self(Arc::new(RwLock::new((Instant::now(), clients))))
    }
    pub fn replace(&self, clients: Vec<RegisteredRelayClient>) {
        if let Ok(mut state) = self.0.write() {
            *state = (Instant::now(), clients);
        }
    }
    pub fn permits(&self, peer: &str, service: Option<&str>) -> bool {
        self.0.read().is_ok_and(|state| {
            state.0.elapsed() <= Duration::from_secs(10)
                && state.1.iter().any(|client| {
                    service.is_none_or(|id| client.id == id)
                        && client.identities.iter().any(|id| id == peer)
                })
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn onboarding_and_offboarding_change_both_new_and_existing_connections() {
        let enrollment = Enrollment::new(Vec::new());
        let peer = "spiffe://proompteng.ai/ns/example/sa/example";
        assert!(!enrollment.permits(peer, None));
        enrollment.replace(vec![RegisteredRelayClient {
            id: "example".into(),
            identities: vec![peer.into()],
        }]);
        assert!(enrollment.permits(peer, Some("example")));
        assert!(!enrollment.permits(peer, Some("opencode")));
        enrollment.0.write().unwrap().0 = Instant::now() - Duration::from_secs(11);
        assert!(!enrollment.permits(peer, None));
        enrollment.replace(Vec::new());
        assert!(!enrollment.permits(peer, Some("example")));
    }
}
