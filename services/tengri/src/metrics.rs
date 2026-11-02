use std::{
    collections::{HashMap, HashSet},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::{
    crd::{MicroVM, MicroVMPhase},
    tickets::TicketStats,
};

static METRICS: OnceLock<Metrics> = OnceLock::new();

const LATENCY_BOUNDS_MICROS: [u64; 17] = [
    1_000,
    5_000,
    10_000,
    25_000,
    50_000,
    100_000,
    250_000,
    300_000,
    500_000,
    1_000_000,
    2_500_000,
    5_000_000,
    10_000_000,
    30_000_000,
    60_000_000,
    120_000_000,
    300_000_000,
];

#[derive(Clone, Copy)]
#[repr(usize)]
pub enum Latency {
    GuestConnect,
    SupervisorAdmission,
    TerminalAttach,
    TerminalFirstOutput,
    TerminalHeartbeat,
    Boot,
    Resume,
    RunStatus,
    ActiveRuns,
}

impl Latency {
    const ALL: [Self; 9] = [
        Self::GuestConnect,
        Self::SupervisorAdmission,
        Self::TerminalAttach,
        Self::TerminalFirstOutput,
        Self::TerminalHeartbeat,
        Self::Boot,
        Self::Resume,
        Self::RunStatus,
        Self::ActiveRuns,
    ];

    fn definition(self) -> (&'static str, &'static str) {
        match self {
            Self::GuestConnect => (
                "tengri_guest_connect_seconds",
                "Guest transport setup and identity verification attempt duration.",
            ),
            Self::SupervisorAdmission => (
                "tengri_supervisor_admission_seconds",
                "Supervisor gate, runner ownership check, and guest transport admission attempt duration.",
            ),
            Self::TerminalAttach => (
                "tengri_terminal_attach_seconds",
                "Time from upgraded terminal WebSocket to guest attachment readiness.",
            ),
            Self::TerminalFirstOutput => (
                "tengri_terminal_first_output_seconds",
                "Time from upgraded terminal WebSocket to its first nonempty PTY output.",
            ),
            Self::TerminalHeartbeat => (
                "tengri_terminal_heartbeat_seconds",
                "Terminal ping round trip from control plane through the guest; excludes browser transport.",
            ),
            Self::Boot => (
                "tengri_agent_boot_latency_seconds",
                "Successful CR creation to guest readiness, including reconciliation retries; excludes BFF admission.",
            ),
            Self::Resume => (
                "tengri_agent_resume_latency_seconds",
                "Successful persisted resume intent to guest readiness, including retries; excludes BFF admission.",
            ),
            Self::RunStatus => (
                "tengri_run_status_seconds",
                "Restate run-status read duration including retries and failed or cancelled attempts; excludes authorization.",
            ),
            Self::ActiveRuns => (
                "tengri_active_runs_seconds",
                "Restate active-run enumeration and status fanout duration including failed or cancelled attempts; excludes authorization.",
            ),
        }
    }
}

#[derive(Clone, Copy)]
#[repr(usize)]
pub(crate) enum Dependency {
    Authorization,
    Database,
    Kubernetes,
}

impl Dependency {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Authorization => "authorization",
            Self::Database => "database",
            Self::Kubernetes => "kubernetes",
        }
    }
}

struct Inventory {
    active: u64,
    sleeping: u64,
    failed: u64,
    pending_tickets: usize,
    previews: usize,
    updated: Instant,
    timestamp: f64,
}

#[derive(Clone, Copy, Default)]
struct Histogram {
    buckets: [u64; LATENCY_BOUNDS_MICROS.len() + 1],
    sum_micros: u64,
}

pub struct LatencyTimer<'a> {
    metrics: &'a Metrics,
    kind: Latency,
    started: Instant,
}

impl Drop for LatencyTimer<'_> {
    fn drop(&mut self) {
        self.metrics
            .observe_latency(self.kind, self.started.elapsed());
    }
}

#[derive(Default)]
pub struct Metrics {
    latency: [Mutex<Histogram>; Latency::ALL.len()],
    inventory: Mutex<Option<Inventory>>,
    readiness_errors: [AtomicU64; 3],
    readiness_timeouts: [AtomicU64; 3],
    guest_failures: AtomicU64,
    preview_sessions_issued: AtomicU64,
    pty_sessions_active: Mutex<HashMap<String, HashSet<String>>>,
    pty_sessions_created: AtomicU64,
    quota_rejections: AtomicU64,
}

pub fn global() -> &'static Metrics {
    METRICS.get_or_init(Metrics::default)
}

impl Metrics {
    pub fn latency_timer(&self, kind: Latency) -> LatencyTimer<'_> {
        LatencyTimer {
            metrics: self,
            kind,
            started: Instant::now(),
        }
    }

    pub fn observe_latency(&self, kind: Latency, duration: Duration) {
        let micros = u64::try_from(duration.as_micros()).unwrap_or(u64::MAX);
        let bucket = LATENCY_BOUNDS_MICROS.partition_point(|bound| *bound < micros);
        let mut histogram = self.latency[kind as usize]
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        histogram.buckets[bucket] = histogram.buckets[bucket].saturating_add(1);
        histogram.sum_micros = histogram.sum_micros.saturating_add(micros);
    }

    pub fn render_latencies(&self) -> String {
        use std::fmt::Write;

        let mut rendered = String::new();
        for kind in Latency::ALL {
            let (name, help) = kind.definition();
            let histogram = *self.latency[kind as usize]
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            writeln!(rendered, "# HELP {name} {help}\n# TYPE {name} histogram").unwrap();
            let mut count = 0_u64;
            for (bound, observations) in LATENCY_BOUNDS_MICROS.iter().zip(histogram.buckets) {
                count = count.saturating_add(observations);
                let bound = *bound as f64 / 1_000_000.0;
                writeln!(rendered, "{name}_bucket{{le=\"{bound}\"}} {count}").unwrap();
            }
            count = count.saturating_add(histogram.buckets[LATENCY_BOUNDS_MICROS.len()]);
            writeln!(rendered, "{name}_bucket{{le=\"+Inf\"}} {count}").unwrap();
            writeln!(
                rendered,
                "{name}_sum {}",
                histogram.sum_micros as f64 / 1_000_000.0
            )
            .unwrap();
            writeln!(rendered, "{name}_count {count}").unwrap();
        }
        rendered
    }

    pub fn observe_boot(&self, millis: u64) {
        self.observe_latency(Latency::Boot, Duration::from_millis(millis));
    }

    pub fn observe_resume(&self, millis: u64) {
        self.observe_latency(Latency::Resume, Duration::from_millis(millis));
    }

    pub(crate) fn readiness_failed(&self, dependency: Dependency, timed_out: bool) {
        let counters = if timed_out {
            &self.readiness_timeouts
        } else {
            &self.readiness_errors
        };
        counters[dependency as usize].fetch_add(1, Ordering::Relaxed);
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

    pub fn update_inventory(&self, agents: &[MicroVM], tickets: TicketStats) {
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
        *self
            .inventory
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Inventory {
            active,
            sleeping,
            failed,
            pending_tickets: tickets.pending,
            previews: tickets.previews,
            updated: Instant::now(),
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64(),
        });
    }

    pub fn render(&self) -> String {
        use std::fmt::Write;

        let mut inventory = String::new();
        let mut last_success = 0.0;
        if let Some(snapshot) = self
            .inventory
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            last_success = snapshot.timestamp;
            writeln!(inventory, "# HELP tengri_agents Last successfully observed MicroVM counts; check inventory freshness.\n# TYPE tengri_agents gauge").unwrap();
            for (state, count) in [
                ("active", snapshot.active),
                ("sleeping", snapshot.sleeping),
                ("failed", snapshot.failed),
            ] {
                writeln!(inventory, "tengri_agents{{state=\"{state}\"}} {count}").unwrap();
            }
            writeln!(inventory, "# HELP tengri_ticket_records Last successfully observed ticket counts; check inventory freshness.\n# TYPE tengri_ticket_records gauge").unwrap();
            writeln!(inventory, "tengri_ticket_records{{scope=\"pending\"}} {}\ntengri_ticket_records{{scope=\"preview\"}} {}", snapshot.pending_tickets, snapshot.previews).unwrap();
            writeln!(inventory, "# HELP tengri_inventory_age_seconds Age of the last successful readiness inventory.\n# TYPE tengri_inventory_age_seconds gauge\ntengri_inventory_age_seconds {}", snapshot.updated.elapsed().as_secs_f64()).unwrap();
        }
        writeln!(inventory, "# HELP tengri_inventory_last_success_timestamp_seconds Unix time of the last successful readiness inventory, or zero before the first success.\n# TYPE tengri_inventory_last_success_timestamp_seconds gauge\ntengri_inventory_last_success_timestamp_seconds {last_success}").unwrap();
        writeln!(inventory, "# HELP tengri_readiness_failures_total Readiness dependency failures by bounded dependency and outcome.\n# TYPE tengri_readiness_failures_total counter").unwrap();
        for dependency in [
            Dependency::Authorization,
            Dependency::Database,
            Dependency::Kubernetes,
        ] {
            for (outcome, count) in [
                (
                    "error",
                    self.readiness_errors[dependency as usize].load(Ordering::Relaxed),
                ),
                (
                    "timeout",
                    self.readiness_timeouts[dependency as usize].load(Ordering::Relaxed),
                ),
            ] {
                writeln!(inventory, "tengri_readiness_failures_total{{dependency=\"{}\",outcome=\"{outcome}\"}} {count}", dependency.name()).unwrap();
            }
        }
        format!(
            concat!(
                "{inventory}",
                "# HELP tengri_guest_failures_total Guest API or readiness failures.\n",
                "# TYPE tengri_guest_failures_total counter\n",
                "tengri_guest_failures_total {guest_failures}\n",
                "# HELP tengri_quota_rejections_total Requests rejected by Ofz reservations or the Kubernetes quota.\n",
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
                "{latencies}",
            ),
            inventory = inventory,
            guest_failures = self.guest_failures.load(Ordering::Relaxed),
            quota = self.quota_rejections.load(Ordering::Relaxed),
            pty_active = self
                .pty_sessions_active
                .lock()
                .map(|sessions| sessions.values().map(HashSet::len).sum::<usize>())
                .unwrap_or_default(),
            pty_created = self.pty_sessions_created.load(Ordering::Relaxed),
            preview_issued = self.preview_sessions_issued.load(Ordering::Relaxed),
            latencies = self.render_latencies(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_metrics_remain_available_without_inventory_and_do_not_invent_counts() {
        let metrics = Metrics::default();
        metrics.observe_resume(350);
        metrics.readiness_failed(Dependency::Database, true);
        metrics.readiness_failed(Dependency::Authorization, false);
        let rendered = metrics.render();
        assert!(!rendered.contains("tengri_agents{"));
        assert!(!rendered.contains("tengri_ticket_records{"));
        assert!(rendered.contains("tengri_agent_resume_latency_seconds_sum 0.35\n"));
        assert!(rendered.contains("tengri_agent_resume_latency_seconds_bucket{le=\"0.5\"} 1\n"));
        assert!(rendered.contains(
            "tengri_readiness_failures_total{dependency=\"database\",outcome=\"timeout\"} 1\n"
        ));
        assert!(rendered.contains(
            "tengri_readiness_failures_total{dependency=\"authorization\",outcome=\"error\"} 1\n"
        ));
        metrics.update_inventory(
            &[],
            TicketStats {
                pending: 2,
                previews: 1,
            },
        );
        let observed = metrics.render();
        assert!(observed.contains("tengri_agents{state=\"active\"} 0\n"));
        assert!(observed.contains("tengri_ticket_records{scope=\"pending\"} 2\n"));
        assert!(observed.contains("tengri_inventory_age_seconds "));
        assert!(observed.contains("tengri_inventory_last_success_timestamp_seconds "));
    }

    #[test]
    fn exports_non_sensitive_prometheus_metrics() {
        let metrics = Metrics::default();
        metrics.observe_boot(1_250);
        metrics.record_pty_created("agent", "terminal");
        metrics.update_inventory(
            &[],
            TicketStats {
                pending: 1,
                previews: 2,
            },
        );
        let rendered = metrics.render();
        assert!(rendered.contains("tengri_agent_boot_latency_seconds_sum 1.25"));
        assert!(rendered.contains("tengri_pty_sessions_active 1"));
        assert!(!rendered.contains("owner_hash"));
    }

    #[test]
    fn latency_histogram_preserves_boundaries_overflow_and_cumulative_counts() {
        let metrics = Metrics::default();
        for micros in [0, 100_000, 100_001, 30_000_001] {
            metrics.observe_latency(Latency::TerminalHeartbeat, Duration::from_micros(micros));
        }
        let rendered = metrics.render_latencies();
        assert!(rendered.contains("tengri_terminal_heartbeat_seconds_bucket{le=\"0.001\"} 1\n"));
        assert!(rendered.contains("tengri_terminal_heartbeat_seconds_bucket{le=\"0.1\"} 2\n"));
        assert!(rendered.contains("tengri_terminal_heartbeat_seconds_bucket{le=\"0.25\"} 3\n"));
        assert!(rendered.contains("tengri_terminal_heartbeat_seconds_bucket{le=\"30\"} 3\n"));
        assert!(rendered.contains("tengri_terminal_heartbeat_seconds_bucket{le=\"+Inf\"} 4\n"));
        assert!(rendered.contains("tengri_terminal_heartbeat_seconds_sum 30.200002\n"));
        assert!(rendered.contains("tengri_terminal_heartbeat_seconds_count 4\n"));
        assert!(rendered.contains("tengri_guest_connect_seconds_count 0\n"));
    }
}
