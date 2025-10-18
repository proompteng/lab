use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::Mutex;
use std::vec::Vec;

#[repr(C)]
pub struct PendingResult<T> {
    receiver: Mutex<Option<Receiver<Result<T, String>>>>,
    result: Mutex<Option<Result<T, String>>>,
}

#[derive(Debug)]
pub enum PendingState {
    Pending,
    ReadyOk,
    ReadyErr(String),
}

impl<T> PendingResult<T> {
    pub fn new(receiver: Receiver<Result<T, String>>) -> Self {
        Self {
            receiver: Mutex::new(Some(receiver)),
            result: Mutex::new(None),
        }
    }

    pub fn poll(&self) -> PendingState {
        {
            let result = self.result.lock().unwrap();
            if let Some(Ok(_)) = result.as_ref() {
                return PendingState::ReadyOk;
            }
            if let Some(Err(err)) = result.as_ref() {
                return PendingState::ReadyErr(err.clone());
            }
        }

        let maybe_result = {
            let mut receiver_guard = self.receiver.lock().unwrap();
            if let Some(receiver) = receiver_guard.as_mut() {
                match receiver.try_recv() {
                    Ok(result) => {
                        *receiver_guard = None;
                        Some(result)
                    }
                    Err(TryRecvError::Empty) => return PendingState::Pending,
                    Err(TryRecvError::Disconnected) => {
                        *receiver_guard = None;
                        Some(Err("pending operation channel disconnected".to_string()))
                    }
                }
            } else {
                None
            }
        };

        if let Some(result) = maybe_result {
            let mut result_guard = self.result.lock().unwrap();
            *result_guard = Some(result);
        }

        match self.result.lock().unwrap().as_ref() {
            Some(Ok(_)) => PendingState::ReadyOk,
            Some(Err(err)) => PendingState::ReadyErr(err.clone()),
            None => PendingState::Pending,
        }
    }

    pub fn take_result(&self) -> Option<Result<T, String>> {
        self.result.lock().unwrap().take()
    }
}

pub type PendingByteArray = PendingResult<Vec<u8>>;
pub type PendingUnit = PendingResult<()>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_returns_pending_when_not_ready() {
        let (_tx, rx) = std::sync::mpsc::channel();
        let pending: PendingResult<Vec<u8>> = PendingResult::new(rx);

        assert!(matches!(pending.poll(), PendingState::Pending));
        // A second poll should remain pending since no sender ever fulfills it.
        assert!(matches!(pending.poll(), PendingState::Pending));
    }

    #[test]
    fn poll_observes_ready_ok_result() {
        let (tx, rx) = std::sync::mpsc::channel();
        let pending: PendingResult<Vec<u8>> = PendingResult::new(rx);
        tx.send(Ok(vec![1, 2, 3])).expect("send succeeds");

        assert!(matches!(pending.poll(), PendingState::ReadyOk));
        let value = pending
            .take_result()
            .expect("result present")
            .expect("result ok");
        assert_eq!(value, vec![1, 2, 3]);
        // After take_result the internal cache is cleared.
        assert!(pending.take_result().is_none());
    }

    #[test]
    fn poll_observes_ready_err_result() {
        let (tx, rx) = std::sync::mpsc::channel();
        let pending: PendingResult<Vec<u8>> = PendingResult::new(rx);
        tx.send(Err("boom".to_string())).expect("send succeeds");

        match pending.poll() {
            PendingState::ReadyErr(err) => assert_eq!(err, "boom"),
            other => panic!("expected ReadyErr, got {other:?}"),
        }

        let err = pending
            .take_result()
            .expect("result present")
            .expect_err("expected error result");
        assert_eq!(err, "boom");
    }
}
