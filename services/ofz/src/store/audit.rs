use std::time::Duration;

use deadpool_postgres::Pool;
use tokio::sync::{OnceCell, mpsc, oneshot};
use tonic::Status;
use tracing::Instrument;

use crate::proto::AuditReceipt;

type Outcome = Result<String, Status>;

struct Submission {
    receipt: AuditReceipt,
    target: String,
    response: oneshot::Sender<Outcome>,
    span: tracing::Span,
}

pub(super) struct AuditWriter {
    pool: Pool,
    sender: OnceCell<mpsc::Sender<Submission>>,
}

impl AuditWriter {
    pub(super) fn new(pool: Pool) -> Self {
        Self {
            pool,
            sender: OnceCell::new(),
        }
    }

    pub(super) async fn record(&self, receipt: &AuditReceipt, target: &str) -> Outcome {
        let sender = self
            .sender
            .get_or_init(|| async {
                let (sender, receiver) = mpsc::channel(128);
                tokio::spawn(run(self.pool.clone(), receiver));
                sender
            })
            .await;
        let (response, result) = oneshot::channel();
        sender
            .try_send(Submission {
                receipt: receipt.clone(),
                target: target.into(),
                response,
                span: tracing::Span::current(),
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    Status::resource_exhausted("audit queue full")
                }
                mpsc::error::TrySendError::Closed(_) => {
                    Status::unavailable("audit writer unavailable")
                }
            })?;
        result
            .await
            .map_err(|_| Status::unavailable("audit writer unavailable"))?
    }
}

async fn run(pool: Pool, mut receiver: mpsc::Receiver<Submission>) {
    while let Some(first) = receiver.recv().await {
        let mut batch = vec![first];
        let flush = tokio::time::sleep(Duration::from_millis(5));
        tokio::pin!(flush);
        while batch.len() < 32 {
            tokio::select! {
                biased;
                _ = &mut flush => break,
                next = receiver.recv() => match next {
                    Some(next) => batch.push(next),
                    None => break,
                }
            }
        }
        match commit(&pool, &batch).await {
            Ok(outcomes) => {
                for (submission, outcome) in batch.into_iter().zip(outcomes) {
                    let _ = submission.response.send(outcome);
                }
            }
            Err(error) => {
                for submission in batch {
                    let _ = submission.response.send(Err(error.clone()));
                }
            }
        }
    }
}

async fn commit(pool: &Pool, batch: &[Submission]) -> Result<Vec<Outcome>, Status> {
    let mut client = pool
        .get()
        .await
        .map_err(|_| Status::unavailable("control database pool unavailable"))?;
    let mut transaction = client.transaction().await.map_err(super::sql_error)?;
    transaction
        .batch_execute("SET LOCAL statement_timeout = 5000")
        .await
        .map_err(super::sql_error)?;
    let mut outcomes = Vec::with_capacity(batch.len());
    for submission in batch {
        let savepoint = transaction.transaction().await.map_err(super::sql_error)?;
        let outcome = async {
            super::record_audit(&*savepoint, &submission.receipt, &submission.target).await?;
            if !super::record_activity(&*savepoint, &submission.receipt).await? {
                return Err(Status::unauthenticated("session expired or revoked"));
            }
            Ok(submission.receipt.id.clone())
        }
        .instrument(submission.span.clone())
        .await;
        if outcome.is_ok() {
            savepoint.commit().await.map_err(super::sql_error)?;
        } else {
            savepoint.rollback().await.map_err(super::sql_error)?;
        }
        outcomes.push(outcome);
    }
    transaction.commit().await.map_err(super::sql_error)?;
    Ok(outcomes)
}
