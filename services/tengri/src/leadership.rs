use std::{future::Future, sync::Arc, time::Duration};

use anyhow::ensure;
use tokio::{
    sync::watch,
    time::{Instant, timeout},
};
use uuid::Uuid;

use crate::control::{Database, Fence};

pub(crate) const LEASE_DURATION: Duration = Duration::from_secs(60);
const RENEW_INTERVAL: Duration = Duration::from_secs(5);
const RENEW_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy)]
pub(crate) struct Authority {
    fence: Fence,
    deadline: Instant,
}

#[derive(Clone)]
pub struct Guard {
    authority: watch::Receiver<Option<Authority>>,
    fence: Fence,
}

impl Guard {
    pub fn fence(&self) -> anyhow::Result<Fence> {
        ensure!(
            self.authority
                .borrow()
                .is_some_and(|authority| authority.fence == self.fence
                    && authority.deadline > Instant::now()),
            "controller leadership expired or changed"
        );
        Ok(self.fence)
    }

    #[cfg(test)]
    pub(crate) fn fixture() -> (watch::Sender<Option<Authority>>, Self) {
        let fence = Fence {
            owner: Uuid::new_v4(),
            generation: 1,
        };
        let (sender, authority) = watch::channel(Some(Authority {
            fence,
            deadline: Instant::now() + LEASE_DURATION,
        }));
        (sender, Self { authority, fence })
    }
}

pub struct Election {
    owner: Uuid,
    database: Arc<Database>,
    authority: watch::Sender<Option<Authority>>,
}

impl Election {
    pub fn new(owner: Uuid, database: Arc<Database>) -> anyhow::Result<Self> {
        ensure!(!owner.is_nil(), "controller Pod UID required");
        let (authority, _) = watch::channel(None);
        Ok(Self {
            owner,
            database,
            authority,
        })
    }

    pub async fn run(self, context: crate::controller::ControllerContext) {
        loop {
            let authority = match acquire_authority(self.acquire()).await {
                Ok(Some(authority)) => authority,
                Ok(None) => {
                    tokio::time::sleep(RENEW_INTERVAL).await;
                    continue;
                }
                Err(error) => {
                    tracing::warn!(error=%error, "controller leadership acquisition failed");
                    tokio::time::sleep(RENEW_INTERVAL).await;
                    continue;
                }
            };
            let fence = authority.fence;
            self.authority.send_replace(Some(authority));
            let guard = Guard {
                authority: self.authority.subscribe(),
                fence,
            };
            tracing::info!(
                generation = fence.generation,
                "controller leadership acquired"
            );
            let mut leader_context = context.clone();
            leader_context.leadership = Some(guard);
            {
                let work = crate::controller::run(leader_context);
                tokio::pin!(work);
                tokio::select! {
                    _ = &mut work => tracing::warn!("controller work ended"),
                    result = renew_authority(&self.authority, authority, || self.renew(fence)) => {
                        if let Err(error) = result {
                            tracing::warn!(error = %error, "controller leadership renewal failed");
                        }
                    }
                }
                self.authority.send_replace(None);
            }
            // Admission closes before releasing shared authority. A crashed
            // process cannot release it; the SQL deadline bounds takeover.
            let _ = timeout(RENEW_TIMEOUT, self.database.release(fence)).await;
            tracing::warn!(
                generation = fence.generation,
                "controller leadership relinquished"
            );
        }
    }

    async fn acquire(&self) -> anyhow::Result<Option<Fence>> {
        self.database.acquire(self.owner).await.map_err(Into::into)
    }

    async fn renew(&self, fence: Fence) -> anyhow::Result<bool> {
        self.database.renew(fence).await.map_err(Into::into)
    }
}

async fn acquire_authority(
    acquire: impl Future<Output = anyhow::Result<Option<Fence>>>,
) -> anyhow::Result<Option<Authority>> {
    let started = Instant::now();
    let Some(fence) = timeout(LEASE_DURATION, acquire).await?? else {
        return Ok(None);
    };
    let deadline = started + LEASE_DURATION;
    ensure!(
        deadline > Instant::now(),
        "controller acquisition arrived after expiry"
    );
    Ok(Some(Authority { fence, deadline }))
}

async fn renew_authority<F, R>(
    sender: &watch::Sender<Option<Authority>>,
    mut authority: Authority,
    mut renew: F,
) -> anyhow::Result<()>
where
    F: FnMut() -> R,
    R: Future<Output = anyhow::Result<bool>>,
{
    let mut interval = tokio::time::interval(RENEW_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    interval.tick().await;
    loop {
        let attempt = async {
            interval.tick().await;
            let started = Instant::now();
            let renewal = renew();
            tokio::pin!(renewal);
            let result = match timeout(RENEW_TIMEOUT, &mut renewal).await {
                Ok(result) => result,
                Err(_) => {
                    tracing::warn!(
                        generation = authority.fence.generation,
                        "controller leadership renewal pending within confirmed lease"
                    );
                    renewal.await
                }
            };
            (started, result)
        };
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(authority.deadline) => {
                anyhow::bail!("confirmed controller leadership expired");
            }
            (started, result) = attempt => match result {
                Ok(true) => {
                    ensure!(authority.deadline > Instant::now(), "controller renewal arrived after expiry");
                    authority.deadline = started + LEASE_DURATION;
                    sender.send_replace(Some(authority));
                }
                Ok(false) => anyhow::bail!("controller leadership ownership changed"),
                Err(error) => return Err(error),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires disposable shared TLS PostgreSQL from test-runtime.sh"]
    async fn runtime_shared_state_election_uses_sql_without_kubernetes() {
        let first =
            Election::new(Uuid::new_v4(), Arc::new(Database::shared_fixture().await)).unwrap();
        let second =
            Election::new(Uuid::new_v4(), Arc::new(Database::shared_fixture().await)).unwrap();
        let (left, right) = tokio::join!(
            acquire_authority(first.acquire()),
            acquire_authority(second.acquire()),
        );
        let (left, right) = (left.unwrap(), right.unwrap());
        assert_ne!(left.is_some(), right.is_some());
        let (leader, follower, authority) = match (left, right) {
            (Some(authority), None) => (&first, &second, authority),
            (None, Some(authority)) => (&second, &first, authority),
            _ => panic!("SQL must elect exactly one controller"),
        };
        leader.authority.send_replace(Some(authority));
        let old_guard = Guard {
            authority: leader.authority.subscribe(),
            fence: authority.fence,
        };
        assert!(old_guard.fence().is_ok());
        assert!(leader.renew(authority.fence).await.unwrap());
        assert!(follower.acquire().await.unwrap().is_none());
        leader.authority.send_replace(None);
        leader.database.release(authority.fence).await.unwrap();
        assert!(old_guard.fence().is_err());

        let next = acquire_authority(follower.acquire())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(next.fence.owner, follower.owner);
        assert!(next.fence.generation > authority.fence.generation);
        assert!(
            leader
                .database
                .require_fence(authority.fence)
                .await
                .is_err()
        );
        assert!(!leader.renew(authority.fence).await.unwrap());
        // A retired process cannot release its successor's ownership.
        leader.database.release(authority.fence).await.unwrap();
        assert!(follower.database.require_fence(next.fence).await.is_ok());
        follower.database.release(next.fence).await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn observed_commit_tail_keeps_confirmed_leadership_without_restarting_its_clock() {
        let (sender, guard) = Guard::fixture();
        let authority = *sender.borrow().as_ref().unwrap();
        let begun = Instant::now();
        let renewal = renew_authority(&sender, authority, || async {
            tokio::time::sleep(Duration::from_secs(21)).await;
            Ok(true)
        });
        tokio::pin!(renewal);
        tokio::select! {
            result = &mut renewal => panic!("observed commit delay discarded leadership: {result:?}"),
            _ = tokio::time::sleep(RENEW_INTERVAL + Duration::from_millis(21_250)) => {}
        }
        assert_eq!(
            sender.borrow().as_ref().unwrap().deadline,
            begun + RENEW_INTERVAL + LEASE_DURATION
        );
        assert!(guard.fence().is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn acquisition_waits_for_the_commit_without_extending_the_confirmed_window() {
        let fence = Fence {
            owner: Uuid::new_v4(),
            generation: 1,
        };
        let started = Instant::now();
        let authority = acquire_authority(async {
            tokio::time::sleep(Duration::from_secs(21)).await;
            Ok(Some(fence))
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(authority.fence, fence);
        assert_eq!(authority.deadline, started + LEASE_DURATION);
        assert_eq!(
            authority.deadline - Instant::now(),
            LEASE_DURATION - Duration::from_secs(21)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_commits_do_not_trigger_a_burst_of_overdue_renewals() {
        let (sender, _) = Guard::fixture();
        let authority = *sender.borrow().as_ref().unwrap();
        let attempts = std::sync::atomic::AtomicUsize::new(0);
        let renewal = renew_authority(&sender, authority, || {
            let first = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
            async move {
                if first {
                    tokio::time::sleep(Duration::from_secs(21)).await;
                }
                Ok(true)
            }
        });
        tokio::pin!(renewal);
        tokio::select! {
            result = &mut renewal => panic!("renewal stopped: {result:?}"),
            _ = tokio::time::sleep(RENEW_INTERVAL + Duration::from_millis(21_250)) => {}
        }
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn an_unconfirmed_acquisition_never_grants_authority() {
        let started = Instant::now();
        assert!(acquire_authority(std::future::pending()).await.is_err());
        assert_eq!(Instant::now() - started, LEASE_DURATION);
        assert!(
            acquire_authority(async { Ok(None) })
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn slow_renewal_keeps_the_inflight_attempt_and_conservative_deadline() {
        let (sender, guard) = Guard::fixture();
        let original = *sender.borrow().as_ref().unwrap();
        let begun = Instant::now();
        let attempts = std::sync::atomic::AtomicUsize::new(0);
        let renewal = renew_authority(&sender, original, || {
            attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async {
                tokio::time::sleep(Duration::from_secs(4)).await;
                Ok(true)
            }
        });
        tokio::pin!(renewal);
        tokio::select! {
            result = &mut renewal => panic!("unexpired leadership was discarded: {result:?}"),
            _ = tokio::time::sleep(Duration::from_secs(8)) => {}
        }
        assert_eq!(
            sender.borrow().as_ref().unwrap().deadline,
            original.deadline
        );
        assert!(guard.fence().is_ok());
        tokio::select! {
            result = &mut renewal => panic!("renewed leadership was discarded: {result:?}"),
            _ = tokio::time::sleep(Duration::from_millis(1250)) => {}
        }
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            sender.borrow().as_ref().unwrap().deadline,
            begun + RENEW_INTERVAL + LEASE_DURATION
        );
        assert!(guard.fence().is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn failed_renewals_end_at_the_confirmed_deadline() {
        let (sender, guard) = Guard::fixture();
        let authority = *sender.borrow().as_ref().unwrap();
        let begun = Instant::now();
        let result = renew_authority(&sender, authority, || {
            std::future::pending::<anyhow::Result<bool>>()
        })
        .await;
        assert!(result.is_err());
        assert_eq!(Instant::now() - begun, LEASE_DURATION);
        assert!(guard.fence().is_err());
        assert_eq!(
            sender.borrow().as_ref().unwrap().deadline,
            authority.deadline
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_renewal_never_extends_expired_authority() {
        let (sender, guard) = Guard::fixture();
        let authority = Authority {
            deadline: Instant::now() + Duration::from_secs(6),
            ..*sender.borrow().as_ref().unwrap()
        };
        sender.send_replace(Some(authority));
        let begun = Instant::now();
        let result = timeout(
            Duration::from_secs(7),
            renew_authority(&sender, authority, || async {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                Ok(true)
            }),
        )
        .await
        .expect("expired authority kept renewing");
        assert!(result.is_err());
        assert_eq!(Instant::now() - begun, Duration::from_secs(6));
        assert!(guard.fence().is_err());
        assert_eq!(
            sender.borrow().as_ref().unwrap().deadline,
            authority.deadline
        );
    }

    #[tokio::test(start_paused = true)]
    async fn known_ownership_loss_and_errors_close_without_retry() {
        for lost in [true, false] {
            let (sender, _) = Guard::fixture();
            let authority = *sender.borrow().as_ref().unwrap();
            let begun = Instant::now();
            let mut attempts = 0;
            let result = renew_authority(&sender, authority, || {
                attempts += 1;
                async move {
                    if lost {
                        Ok(false)
                    } else {
                        anyhow::bail!("renewal was denied")
                    }
                }
            })
            .await;
            assert!(result.is_err());
            assert_eq!(attempts, 1);
            assert_eq!(Instant::now() - begun, RENEW_INTERVAL);
        }
    }

    #[tokio::test]
    async fn lost_or_replaced_authority_closes_old_guards() {
        let (authority, guard) = Guard::fixture();
        let first = guard.fence().unwrap();
        authority.send_replace(Some(Authority {
            fence: Fence {
                generation: first.generation + 1,
                ..first
            },
            deadline: Instant::now() + LEASE_DURATION,
        }));
        assert!(guard.fence().is_err());
        authority.send_replace(None);
        assert!(guard.fence().is_err());
    }

    #[tokio::test]
    async fn local_deadline_fences_even_before_next_renewal() {
        let (authority, guard) = Guard::fixture();
        let fence = guard.fence().unwrap();
        authority.send_replace(Some(Authority {
            fence,
            deadline: Instant::now() - Duration::from_millis(1),
        }));
        assert!(guard.fence().is_err());
    }
}
