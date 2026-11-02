use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
};

use tokio::sync::Mutex;
use tonic::Status;

const BUCKETS: usize = 64;
const CAPACITY_PER_BUCKET: usize = 128;

pub(super) struct Window {
    buckets: [Mutex<HashMap<[u8; 32], u64>>; BUCKETS],
    clock_floor: AtomicU64,
}

impl Default for Window {
    fn default() -> Self {
        Self {
            buckets: std::array::from_fn(|_| Mutex::new(HashMap::new())),
            clock_floor: AtomicU64::new(0),
        }
    }
}

impl Window {
    pub(super) async fn consume(&self, nonce: [u8; 32], deadline: u64) -> Result<(), Status> {
        let mut bucket = self.buckets[nonce[0] as usize % BUCKETS].lock().await;
        let observed = crate::ofz::now_ms()?;
        let now = self
            .clock_floor
            .fetch_max(observed, Ordering::Relaxed)
            .max(observed);
        if deadline <= now || deadline > now + 5000 {
            return Err(Status::unauthenticated("request nonce deadline expired"));
        }
        bucket.retain(|_, expires| *expires > now);
        if bucket.contains_key(&nonce) {
            return Err(Status::unauthenticated("request nonce already used"));
        }
        if bucket.len() == CAPACITY_PER_BUCKET {
            return Err(Status::resource_exhausted("request replay window full"));
        }
        bucket.insert(nonce, deadline);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_backwards_clock_cannot_reopen_an_expired_replay_window() {
        let window = Window::default();
        let now = crate::ofz::now_ms().unwrap();
        let deadline = now + 5000;
        window.consume([0; 32], deadline).await.unwrap();
        // Model expiry/cleanup followed by a wall-clock correction back into the old lifetime.
        window.clock_floor.store(now + 6000, Ordering::Relaxed);
        window.buckets[0].lock().await.clear();
        assert_eq!(
            window.consume([0; 32], deadline).await.unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
        assert!(window.buckets[0].lock().await.is_empty());
    }

    #[tokio::test]
    async fn simultaneous_replay_has_one_winner_and_live_entries_are_never_evicted() {
        let window = Window::default();
        let deadline = crate::ofz::now_ms().unwrap() + 5000;
        let results =
            futures::future::join_all((0..64).map(|_| window.consume([0; 32], deadline))).await;
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert!(
            results
                .iter()
                .filter_map(|r| r.as_ref().err())
                .all(|e| e.code() == tonic::Code::Unauthenticated)
        );
        for n in 1..CAPACITY_PER_BUCKET {
            let mut nonce = [0; 32];
            nonce[1] = n as u8;
            window.consume(nonce, deadline).await.unwrap();
        }
        let mut overflow = [0; 32];
        overflow[2] = 1;
        assert_eq!(
            window.consume(overflow, deadline).await.unwrap_err().code(),
            tonic::Code::ResourceExhausted
        );
        assert_eq!(
            window.consume([0; 32], deadline).await.unwrap_err().code(),
            tonic::Code::Unauthenticated
        );
        let mut expired = [0; 32];
        expired[0] = 1;
        assert_eq!(
            window
                .consume(expired, crate::ofz::now_ms().unwrap())
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unauthenticated
        );
    }
}
