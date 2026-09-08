use std::{
    collections::{HashMap, HashSet},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

use crate::{
    crd::{MicroVM, MicroVMPhase},
    tickets::TicketStats,
};

static METRICS: OnceLock<Metrics> = OnceLock::new();

#[derive(Default)]
pub struct Metrics {
    boot_latency_millis: AtomicU64,
    boot_latency_observations: AtomicU64,
    expiry_deletions: AtomicU64,
    guest_failures: AtomicU64,
    preview_sessions_issued: AtomicU64,
    pty_sessions_active: Mutex<HashMap<String, HashSet<String>>>,
    pty_sessions_created: AtomicU64,
    quota_rejections: AtomicU64,
    resume_latency_millis: AtomicU64,
    resume_latency_observations: AtomicU64,
}

pub fn global() -> &'static Metrics {
    METRICS.get_or_init(Metrics::default)
}

impl Metrics {
    pub fn observe_boot(&self, millis: u64) {
        self.boot_latency_millis
            .fetch_add(millis, Ordering::Relaxed);
        self.boot_latency_observations
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn observe_resume(&self, millis: u64) {
        self.resume_latency_millis
            .fetch_add(millis, Ordering::Relaxed);
        self.resume_latency_observations
            .fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_expiry_deletion(&self) {
        self.expiry_deletions.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_guest_failure(&self) {
        self.guest_failures.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_preview_session(&self) {
        self.preview_sessions_issued.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_pty_created(&self, agent_id: &str, terminal_id: &str) {
        self.pty_sessions_created.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut sessions) = self.pty_sessions_active.lock() {
            sessions
                .entry(agent_id.to_owned())
                .or_default()
                .insert(terminal_id.to_owned());
        }
    }

    pub fn record_pty_terminated(&self, agent_id: &str, terminal_id: &str) {
        if let Ok(mut sessions) = self.pty_sessions_active.lock()
            && let Some(agent_sessions) = sessions.get_mut(agent_id)
        {
            agent_sessions.remove(terminal_id);
            if agent_sessions.is_empty() {
                sessions.remove(agent_id);
            }
        }
    }

    pub fn replace_pty_sessions(
        &self,
        agent_id: &str,
        terminal_ids: impl IntoIterator<Item = String>,
    ) {
        if let Ok(mut sessions) = self.pty_sessions_active.lock() {
            let active = terminal_ids.into_iter().collect::<HashSet<_>>();
            if active.is_empty() {
                sessions.remove(agent_id);
            } else {
                sessions.insert(agent_id.to_owned(), active);
            }
        }
    }

    pub fn clear_pty_sessions(&self, agent_id: &str) {
        if let Ok(mut sessions) = self.pty_sessions_active.lock() {
            sessions.remove(agent_id);
        }
    }

    pub fn record_quota_rejection(&self) {
        self.quota_rejections.fetch_add(1, Ordering::Relaxed);
    }

    pub fn render(&self, agents: &[MicroVM], tickets: TicketStats) -> String {
        let mut active = 0_u64;
        let mut sleeping = 0_u64;
        let mut failed = 0_u64;
        for agent in agents {
            match agent.status.as_ref().map(|status| status.phase) {
                Some(MicroVMPhase::Sleeping) => sleeping += 1,
                Some(MicroVMPhase::Failed) => failed += 1,
                Some(MicroVMPhase::Terminating) => {}
                _ => active += 1,
            }
        }
        format!(
            concat!(
                "# HELP tengri_agents Current MicroVM agents by phase group.\n",
                "# TYPE tengri_agents gauge\n",
                "tengri_agents{{state=\"active\"}} {active}\n",
                "tengri_agents{{state=\"sleeping\"}} {sleeping}\n",
                "tengri_agents{{state=\"failed\"}} {failed}\n",
                "# HELP tengri_agent_boot_latency_seconds Time from CR creation to guest readiness.\n",
                "# TYPE tengri_agent_boot_latency_seconds summary\n",
                "tengri_agent_boot_latency_seconds_sum {boot_sum}\n",
                "tengri_agent_boot_latency_seconds_count {boot_count}\n",
                "# HELP tengri_agent_resume_latency_seconds Time from authenticated wake to guest readiness.\n",
                "# TYPE tengri_agent_resume_latency_seconds summary\n",
                "tengri_agent_resume_latency_seconds_sum {resume_sum}\n",
                "tengri_agent_resume_latency_seconds_count {resume_count}\n",
                "# HELP tengri_expiry_deletions_total MicroVMs deleted at hard expiry.\n",
                "# TYPE tengri_expiry_deletions_total counter\n",
                "tengri_expiry_deletions_total {expiry}\n",
                "# HELP tengri_guest_failures_total Guest API or readiness failures.\n",
                "# TYPE tengri_guest_failures_total counter\n",
                "tengri_guest_failures_total {guest_failures}\n",
                "# HELP tengri_quota_rejections_total Requests rejected by the global MicroVM quota.\n",
                "# TYPE tengri_quota_rejections_total counter\n",
                "tengri_quota_rejections_total {quota}\n",
                "# HELP tengri_pty_sessions_active PTY sessions believed active by this control-plane process.\n",
                "# TYPE tengri_pty_sessions_active gauge\n",
                "tengri_pty_sessions_active {pty_active}\n",
                "# HELP tengri_pty_sessions_created_total PTY sessions created.\n",
                "# TYPE tengri_pty_sessions_created_total counter\n",
                "tengri_pty_sessions_created_total {pty_created}\n",
                "# HELP tengri_preview_sessions_issued_total Preview sessions issued.\n",
                "# TYPE tengri_preview_sessions_issued_total counter\n",
                "tengri_preview_sessions_issued_total {preview_issued}\n",
                "# HELP tengri_ticket_records Current one-use tickets by scope.\n",
                "# TYPE tengri_ticket_records gauge\n",
                "tengri_ticket_records{{scope=\"pending\"}} {pending_tickets}\n",
                "tengri_ticket_records{{scope=\"preview\"}} {preview_sessions}\n",
            ),
            active = active,
            sleeping = sleeping,
            failed = failed,
            boot_sum = self.boot_latency_millis.load(Ordering::Relaxed) as f64 / 1_000.0,
            boot_count = self.boot_latency_observations.load(Ordering::Relaxed),
            resume_sum = self.resume_latency_millis.load(Ordering::Relaxed) as f64 / 1_000.0,
            resume_count = self.resume_latency_observations.load(Ordering::Relaxed),
            expiry = self.expiry_deletions.load(Ordering::Relaxed),
            guest_failures = self.guest_failures.load(Ordering::Relaxed),
            quota = self.quota_rejections.load(Ordering::Relaxed),
            pty_active = self
                .pty_sessions_active
                .lock()
                .map(|sessions| sessions.values().map(HashSet::len).sum::<usize>())
                .unwrap_or_default(),
            pty_created = self.pty_sessions_created.load(Ordering::Relaxed),
            preview_issued = self.preview_sessions_issued.load(Ordering::Relaxed),
            pending_tickets = tickets.pending,
            preview_sessions = tickets.previews,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_non_sensitive_prometheus_metrics() {
        let metrics = Metrics::default();
        metrics.observe_boot(1_250);
        metrics.record_pty_created("agent", "terminal");
        let rendered = metrics.render(
            &[],
            TicketStats {
                pending: 1,
                previews: 2,
            },
        );
        assert!(rendered.contains("tengri_agent_boot_latency_seconds_sum 1.25"));
        assert!(rendered.contains("tengri_pty_sessions_active 1"));
        assert!(!rendered.contains("owner_hash"));
    }
}
