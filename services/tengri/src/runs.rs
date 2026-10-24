use std::{env, sync::Arc, time::Duration};

use restate_sdk::{ingress::ReqwestClient, prelude::*, service::IntoServiceDefinition};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tonic::Status;
use uuid::Uuid;

use crate::{auth::Principal, grpc::ControlPlane};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Input {
    pub id: String,
    pub agent_id: String,
    pub thread_id: String,
    pub text: String,
    pub model: String,
    pub reasoning_effort: String,
    pub images: Vec<Image>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Image {
    pub path: String,
    pub revision: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Envelope {
    payload: String,
    signature: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Admission {
    input: Input,
    principal: Principal,
    digest: String,
    claim: Claim,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Claim {
    workspace_uid: String,
    run_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StopQuery {
    claim: Claim,
    known_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum State {
    Accepted,
    WaitingForGuest {
        reason: String,
    },
    Running {
        turn_id: String,
    },
    WaitingForApproval {
        turn_id: String,
        approvals: Vec<PendingApproval>,
    },
    Cancelling {
        turn_id: Option<String>,
        reason: String,
    },
    Recovering {
        turn_id: String,
        reason: String,
    },
    Succeeded {
        turn_id: String,
    },
    Failed {
        turn_id: String,
        reason: String,
    },
    Cancelled {
        turn_id: String,
    },
    NeedsReconciliation {
        reason: String,
    },
    Rejected {
        reason: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingApproval {
    approval_id: String,
    raw: serde_json::Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Control {
    pub id: String,
    pub run_id: String,
    pub agent_id: String,
    pub principal: Principal,
    pub method: String,
    pub params: serde_json::Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ControlResult {
    pub delivered: bool,
    pub result: serde_json::Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlReceipt {
    digest: String,
    result: ControlResult,
}

fn control_digest(control: &Control) -> Result<String, Status> {
    let bytes = serde_json::to_vec(&(
        &control.id,
        &control.run_id,
        &control.agent_id,
        &control.principal.owner_hash,
        &control.principal.context.workspace_uid,
        &control.method,
        &control.params,
    ))
    .map_err(|_| Status::internal("encode control identity"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

impl State {
    pub(crate) fn terminal(&self) -> bool {
        matches!(
            self,
            Self::Succeeded { .. }
                | Self::Failed { .. }
                | Self::Cancelled { .. }
                | Self::Rejected { .. }
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Snapshot {
    pub run_id: String,
    pub agent_id: String,
    pub thread_id: String,
    owner_hash: String,
    workspace_uid: String,
    digest: String,
    pub state: State,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    run_id: String,
    owner_hash: String,
    workspace_uid: String,
    digest: Option<String>,
    expires_at_ms: u64,
}

pub(crate) fn input_digest(input: &Input) -> Result<String, Status> {
    let bytes = serde_json::to_vec(input).map_err(|_| Status::internal("encode agent run"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

async fn seal<T: Serialize>(
    service: &ControlPlane,
    domain: &str,
    value: &T,
) -> Result<Envelope, Status> {
    let payload =
        serde_json::to_string(value).map_err(|_| Status::internal("encode run admission"))?;
    let signature = service.auth.seal_run(domain, payload.as_bytes()).await?;
    Ok(Envelope { payload, signature })
}

async fn open<T: for<'de> Deserialize<'de>>(
    service: &ControlPlane,
    domain: &str,
    envelope: &Envelope,
) -> Result<T, Status> {
    service
        .auth
        .verify_run(domain, envelope.payload.as_bytes(), &envelope.signature)
        .await?;
    serde_json::from_str(&envelope.payload)
        .map_err(|_| Status::invalid_argument("invalid run admission"))
}

fn ingress() -> Result<ReqwestClient, Status> {
    let url = env::var("TENGRI_RESTATE_INGRESS")
        .map_err(|_| Status::unavailable("durable run ingress is not configured"))?;
    let url: http::Uri = url
        .parse()
        .map_err(|_| Status::internal("invalid durable run ingress"))?;
    if !matches!(url.scheme_str(), Some("http" | "https")) || url.authority().is_none() {
        return Err(Status::internal("invalid durable run ingress"));
    }
    ReqwestClient::connect(url).map_err(|_| Status::unavailable("durable run ingress unavailable"))
}

pub(crate) async fn submit(
    service: &ControlPlane,
    principal: Principal,
    input: Input,
) -> Result<Snapshot, Status> {
    let workspace_uid = principal.context.workspace_uid.clone();
    let claim = Claim {
        workspace_uid: workspace_uid.clone(),
        run_id: input.id.clone(),
    };
    let digest = input_digest(&input)?;
    let admission = Admission {
        input: input.clone(),
        principal: principal.clone(),
        digest: digest.clone(),
        claim,
    };
    let envelope = seal(service, "admission", &admission).await?;
    let client = TengriWorkspaceRunsIngressClient::from_client(ingress()?, workspace_uid);
    tokio::time::timeout(Duration::from_secs(10), client.admit(Json(envelope)).call())
        .await
        .map_err(|_| {
            Status::unavailable("durable run acceptance timed out; retry the same operation")
        })?
        .map_err(client_error)?
        .into_body()
        .map_err(client_error)?;
    for _ in 0..20 {
        match read(service, &principal, &input.id, Some(digest.clone())).await {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) if error.code() == tonic::Code::Unavailable => {
                tokio::time::sleep(Duration::from_millis(100)).await
            }
            Err(error) => return Err(error),
        }
    }
    Err(Status::unavailable(
        "run accepted; retry the same operation to recover its status",
    ))
}

pub(crate) async fn read(
    service: &ControlPlane,
    principal: &Principal,
    id: &str,
    digest: Option<String>,
) -> Result<Snapshot, Status> {
    let query = Query {
        run_id: id.into(),
        owner_hash: principal.owner_hash.clone(),
        workspace_uid: principal.context.workspace_uid.clone(),
        digest,
        expires_at_ms: crate::ofz::now_ms()? + 2000,
    };
    let query = seal(service, "query", &query).await?;
    let client = TengriAgentRunIngressClient::from_client(ingress()?, id.to_owned());
    let result = tokio::time::timeout(Duration::from_secs(2), client.status(Json(query)).call())
        .await
        .map_err(|_| Status::unavailable("durable run status timed out"))?
        .map_err(client_error)?;
    Ok(result.into_body().map_err(client_error)?.into_inner())
}

pub(crate) async fn active(
    service: &ControlPlane,
    principal: &Principal,
) -> Result<Option<Snapshot>, Status> {
    let query = Query {
        run_id: String::new(),
        owner_hash: principal.owner_hash.clone(),
        workspace_uid: principal.context.workspace_uid.clone(),
        digest: None,
        expires_at_ms: crate::ofz::now_ms()? + 2000,
    };
    let envelope = seal(service, "active-query", &query).await?;
    let client = TengriWorkspaceRunsIngressClient::from_client(ingress()?, query.workspace_uid);
    let response =
        tokio::time::timeout(Duration::from_secs(2), client.active(Json(envelope)).call())
            .await
            .map_err(|_| Status::unavailable("active run recovery timed out"))?
            .map_err(client_error)?;
    let id = response.into_body().map_err(client_error)?.into_inner();
    match id {
        Some(id) => read(service, principal, &id, None).await.map(Some),
        None => Ok(None),
    }
}

pub(crate) async fn control(
    service: &ControlPlane,
    control: Control,
) -> Result<ControlResult, Status> {
    let digest = control_digest(&control)?;
    let envelope = seal(service, "control", &control).await?;
    let connection = ingress()?;
    let workspace = TengriWorkspaceRunsIngressClient::from_client(
        connection.clone(),
        control.principal.context.workspace_uid.clone(),
    );
    let client = TengriRunControlIngressClient::from_client(connection, control.id.clone());
    let receipt = tokio::time::timeout(
        Duration::from_secs(20),
        control_receipt(&workspace, &client, envelope),
    )
    .await
    .map_err(|_| Status::unavailable("control accepted; retry the same operation"))?
    .map_err(client_error)?;
    if receipt.digest != digest {
        return Err(Status::already_exists(
            "control ID already has different input",
        ));
    }
    let result = receipt.result;
    if !result.delivered {
        return Err(Status::failed_precondition(
            "control outcome needs reconciliation; it was not resent",
        ));
    }
    Ok(result)
}

async fn control_receipt(
    workspace: &TengriWorkspaceRunsIngressClient<reqwest::Client>,
    client: &TengriRunControlIngressClient<reqwest::Client>,
    envelope: Envelope,
) -> Result<ControlReceipt, restate_sdk::ingress::ClientError> {
    workspace
        .admit_control(Json(envelope))
        .call()
        .await?
        .into_body()?;
    Ok(client
        .handle()
        .await?
        .attach()
        .await?
        .into_body()
        .into_inner())
}

struct TengriRunControl;

#[workflow(workflow_completion_retention = "7 days")]
impl TengriRunControl {
    #[handler(ingress_private = true)]
    async fn run(
        &self,
        ctx: WorkflowContext<'_>,
        control: Json<Control>,
    ) -> HandlerResult<Json<ControlReceipt>> {
        let id = ctx.key().to_owned();
        let control = control.into_inner();
        if control.id != id || Uuid::parse_str(&id).is_err() {
            return Err(TerminalError::new_with_code(400, "invalid control identity").into());
        }
        let digest = control_digest(&control).map_err(terminal)?;
        let result = ctx
            .workflow_client::<TengriAgentRunClient>(&control.run_id)
            .control(Json(control))
            .call()
            .await?
            .into_inner();
        Ok(Json(ControlReceipt { digest, result }))
    }
}

fn client_error(error: restate_sdk::ingress::ClientError) -> Status {
    match error.response().map(|response| response.status().as_u16()) {
        Some(400) => Status::invalid_argument("durable run input or control was rejected"),
        Some(401) => Status::unauthenticated("durable run authorization is invalid"),
        Some(422) => Status::failed_precondition("Codex control was not dispatched"),
        Some(403) => Status::permission_denied("run unavailable"),
        Some(404) => Status::not_found("run is unavailable or its retention expired"),
        Some(409) => Status::already_exists("run or operation conflicts with its recorded state"),
        _ => Status::unavailable("durable run status unavailable"),
    }
}

pub(crate) struct TengriAgentRun {
    service: Arc<ControlPlane>,
}

#[workflow(workflow_completion_retention = "7 days")]
impl TengriAgentRun {
    #[handler(ingress_private = true)]
    async fn run(
        &self,
        ctx: WorkflowContext<'_>,
        admission: Json<Admission>,
    ) -> HandlerResult<Json<State>> {
        let run_id = ctx.key().to_owned();
        let admission = admission.into_inner();
        if admission.input.id != run_id || admission.claim.run_id != run_id {
            return Err(TerminalError::new_with_code(400, "invalid run identity").into());
        }
        let mut snapshot = Snapshot {
            run_id: admission.input.id.clone(),
            agent_id: admission.input.agent_id.clone(),
            thread_id: admission.input.thread_id.clone(),
            owner_hash: admission.principal.owner_hash.clone(),
            workspace_uid: admission.claim.workspace_uid.clone(),
            digest: admission.digest.clone(),
            state: State::Accepted,
        };
        let workspace =
            ctx.object_client::<TengriWorkspaceRunsClient>(&admission.claim.workspace_uid);
        let mut stop = match workspace.claim(Json(admission.claim.clone())).call().await {
            Ok(stop) => stop.into_inner(),
            Err(error) => {
                if error.code() != 409 {
                    return Err(error.into());
                }
                snapshot.state = State::Rejected {
                    reason: "workspace already has an active run".into(),
                };
                ctx.set("snapshot", Json(snapshot.clone()));
                return Ok(Json(snapshot.state));
            }
        };
        ctx.set("snapshot", Json(snapshot.clone()));
        snapshot.state = if stop.is_some() {
            State::Cancelled {
                turn_id: String::new(),
            }
        } else {
            self.start_run(&ctx, &admission).await?
        };
        if !snapshot.state.terminal() {
            ctx.set("snapshot", Json(snapshot.clone()));
        }
        let started_at: u64 = ctx
            .run(|| async { Ok(crate::ofz::now_ms().map_err(terminal)?) })
            .await?;
        let mut approval_started_at = None;
        let mut reconciliation_attempts = 0;
        while !snapshot.state.terminal() {
            if matches!(
                snapshot.state,
                State::Recovering { .. }
                    | State::NeedsReconciliation { .. }
                    | State::Cancelling { .. }
            ) && ctx
                .run(|| async {
                    Ok(self
                        .service
                        .workspace_removal_complete(&admission.principal.context.workspace_uid)
                        .await?)
                })
                .name("read_permanent_removal_receipt")
                .await?
            {
                snapshot.state = State::Cancelled {
                    turn_id: turn_id(&snapshot.state).unwrap_or_default().into(),
                };
                break;
            }
            if matches!(snapshot.state, State::NeedsReconciliation { .. }) {
                if reconciliation_attempts < 5 || reconciliation_attempts == 19 {
                    snapshot.state = ctx
                        .run(|| async {
                            Ok(Json(
                                self.service
                                    .reconcile_durable_run(
                                        &admission.principal,
                                        &admission.input,
                                        &snapshot.state,
                                    )
                                    .await,
                            ))
                        })
                        .name("reconcile_dispatch_receipt")
                        .await?
                        .into_inner();
                    if !snapshot.state.terminal() {
                        ctx.set("snapshot", Json(snapshot.clone()));
                    }
                }
                reconciliation_attempts = if reconciliation_attempts >= 19 {
                    5
                } else {
                    reconciliation_attempts + 1
                };
            }
            if snapshot.state.terminal() {
                break;
            }
            ctx.sleep(Duration::from_secs(2)).await?;
            if let Some(latest) = workspace
                .latest_stop(Json(StopQuery {
                    claim: admission.claim.clone(),
                    known_id: stop
                        .as_ref()
                        .map(|control: &Control| control.id.clone())
                        .unwrap_or_default(),
                }))
                .call()
                .await?
                .into_inner()
            {
                stop = Some(latest);
            }
            let now: u64 = ctx
                .run(|| async { Ok(crate::ofz::now_ms().map_err(terminal)?) })
                .await?;
            match &snapshot.state {
                State::WaitingForApproval { approvals, .. } => {
                    let ids: Vec<String> = approvals
                        .iter()
                        .map(|approval| approval.approval_id.clone())
                        .collect();
                    if approval_started_at
                        .as_ref()
                        .is_none_or(|(previous, _)| previous != &ids)
                    {
                        approval_started_at = Some((ids, now));
                    }
                }
                State::Recovering { .. } => {}
                _ => approval_started_at = None,
            }
            if stop.is_none()
                && (now.saturating_sub(started_at) >= 24 * 60 * 60 * 1000
                    || approval_started_at
                        .as_ref()
                        .is_some_and(|(_, at)| now.saturating_sub(*at) >= 30 * 60 * 1000))
            {
                let bytes: [u8; 16] = Sha256::digest(format!("{}:budget-stop", admission.input.id))
                    [..16]
                    .try_into()
                    .expect("SHA256 prefix");
                stop = Some(Control {
                    id: Uuid::from_bytes(bytes).to_string(),
                    run_id: admission.input.id.clone(),
                    agent_id: admission.input.agent_id.clone(),
                    principal: admission.principal.clone(),
                    method: "turn/interrupt".into(),
                    params: serde_json::json!({}),
                });
            }
            let changed =
                if stop.is_none() && matches!(snapshot.state, State::WaitingForGuest { .. }) {
                    let next = self.start_run(&ctx, &admission).await?;
                    (next != snapshot.state).then_some(next)
                } else {
                    ctx.run(|| async {
                        let next = if let Some(stop) = &stop {
                            self.service
                                .stop_durable_run(stop, &admission.input, &snapshot.state)
                                .await
                        } else {
                            self.service
                                .observe_durable_run(
                                    &admission.principal,
                                    &admission.input,
                                    &snapshot.state,
                                )
                                .await
                        };
                        Ok(Json((next != snapshot.state).then_some(next)))
                    })
                    .name("observe_codex_turn")
                    .await?
                    .into_inner()
                };
            if let Some(next) = changed {
                snapshot.state = next;
                if !snapshot.state.terminal() {
                    ctx.set("snapshot", Json(snapshot.clone()));
                }
            }
        }
        if snapshot.state.terminal() {
            ctx.run(|| async {
                self.service
                    .pin_run(&admission.principal, &admission.input, false)
                    .await
                    .map_err(HandlerError::from)?;
                Ok(())
            })
            .name("release_sleep_fence")
            .await?;
            workspace.release(Json(admission.claim)).call().await?;
        }
        ctx.set("snapshot", Json(snapshot.clone()));
        Ok(Json(snapshot.state))
    }

    #[handler(ingress_private = true)]
    async fn control(
        &self,
        ctx: SharedWorkflowContext<'_>,
        control: Json<Control>,
    ) -> HandlerResult<Json<ControlResult>> {
        let run_id = ctx.key().to_owned();
        let mut control = control.into_inner();
        if control.run_id != run_id {
            return Err(TerminalError::new_with_code(400, "invalid run control").into());
        }
        let snapshot = ctx
            .get::<Json<Snapshot>>("snapshot")
            .await?
            .ok_or_else(|| TerminalError::new_with_code(503, "run is being admitted"))?
            .into_inner();
        if snapshot.owner_hash != control.principal.owner_hash
            || snapshot.workspace_uid != control.principal.context.workspace_uid
            || snapshot.agent_id != control.agent_id
        {
            return Err(TerminalError::new_with_code(403, "run unavailable").into());
        }
        if control.method == "turn/interrupt" {
            if !snapshot.state.terminal() {
                ctx.object_client::<TengriWorkspaceRunsClient>(&snapshot.workspace_uid)
                    .store_stop(Json(control))
                    .call()
                    .await?;
            }
            return Ok(Json(ControlResult {
                delivered: true,
                result: serde_json::json!({}),
            }));
        }
        if snapshot.state.terminal()
            || matches!(
                snapshot.state,
                State::NeedsReconciliation { .. } | State::Cancelling { .. }
            )
        {
            return Err(TerminalError::new_with_code(422, "run cannot accept this control").into());
        }
        let turn = turn_id(&snapshot.state)
            .ok_or_else(|| TerminalError::new_with_code(422, "run has not started"))?;
        if control.method == "tengri/resolveApproval" {
            control.params["expectedTurnId"] = serde_json::json!(turn);
        }
        if control
            .params
            .get("threadId")
            .and_then(serde_json::Value::as_str)
            != Some(&snapshot.thread_id)
            || (control.method == "turn/steer"
                && control
                    .params
                    .get("expectedTurnId")
                    .and_then(serde_json::Value::as_str)
                    != Some(turn))
        {
            return Err(
                TerminalError::new_with_code(422, "control belongs to another turn").into(),
            );
        }
        let input = Input {
            id: snapshot.run_id,
            agent_id: snapshot.agent_id,
            thread_id: snapshot.thread_id,
            text: String::new(),
            model: String::new(),
            reasoning_effort: String::new(),
            images: vec![],
        };
        if control.method == "tengri/resolveApproval" {
            ctx.run(|| async {
                let guest = self
                    .service
                    .run_guest(&control.principal, &input)
                    .await
                    .map_err(terminal)?;
                let value = guest
                    .codex_call(
                        "tengri/pending",
                        serde_json::json!({"threadId":input.thread_id}),
                    )
                    .await?;
                let approvals: Vec<PendingApproval> = serde_json::from_value(value)?;
                let id = control
                    .params
                    .get("approvalId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let approval = approvals
                    .into_iter()
                    .find(|approval| approval.approval_id == id)
                    .ok_or_else(|| {
                        TerminalError::new_with_code(422, "approval is stale or unavailable")
                    })?;
                Ok(Json(approval))
            })
            .name("record_exact_approval_intent")
            .await?;
        }
        Ok(ctx
            .run(|| async {
                let guest = self
                    .service
                    .run_guest(&control.principal, &input)
                    .await
                    .map_err(terminal)?;
                Ok(Json(
                    match guest
                        .codex_call(&control.method, control.params.clone())
                        .await
                    {
                        Ok(value) => ControlResult {
                            delivered: true,
                            result: value,
                        },
                        Err(crate::guest::GuestError::CodexOperationRejected) => {
                            return Err(TerminalError::new_with_code(
                                422,
                                "Codex rejected the control before dispatch",
                            )
                            .into());
                        }
                        Err(_) => ControlResult {
                            delivered: false,
                            result: serde_json::json!({}),
                        },
                    },
                ))
            })
            .name("deliver_run_control")
            .await?)
    }

    #[handler(journal_retention = "0s", idempotency_retention = "0s")]
    async fn status(
        &self,
        ctx: SharedWorkflowContext<'_>,
        envelope: Json<Envelope>,
    ) -> HandlerResult<Json<Snapshot>> {
        let run_id = ctx.key().to_owned();
        let query: Query = ctx
            .run(|| async {
                let query: Query = open(&self.service, "query", &envelope.0)
                    .await
                    .map_err(terminal)?;
                if query.expires_at_ms < crate::ofz::now_ms().map_err(terminal)?
                    || query.run_id != run_id
                {
                    return Err(TerminalError::new_with_code(401, "run query expired").into());
                }
                Ok(Json(query))
            })
            .await?
            .into_inner();
        let snapshot = ctx
            .get::<Json<Snapshot>>("snapshot")
            .await?
            .ok_or_else(|| TerminalError::new_with_code(503, "run is being admitted"))?
            .into_inner();
        if snapshot.owner_hash != query.owner_hash || snapshot.workspace_uid != query.workspace_uid
        {
            return Err(TerminalError::new_with_code(403, "run unavailable").into());
        }
        if query.digest.is_some_and(|digest| digest != snapshot.digest) {
            return Err(TerminalError::new_with_code(
                409,
                "operation ID already has different input",
            )
            .into());
        }
        Ok(Json(snapshot))
    }
}

impl TengriAgentRun {
    async fn start_run(
        &self,
        ctx: &WorkflowContext<'_>,
        admission: &Admission,
    ) -> HandlerResult<State> {
        let prepared = ctx
            .run(|| async {
                Ok(Json(
                    self.service
                        .prepare_durable_run(&admission.principal, &admission.input)
                        .await,
                ))
            })
            .name("prepare_codex_dispatch")
            .await?
            .into_inner();
        if !matches!(prepared, State::Accepted) {
            return Ok(prepared);
        }
        self.dispatch_prepared(ctx, admission).await
    }

    async fn dispatch_prepared(
        &self,
        ctx: &WorkflowContext<'_>,
        admission: &Admission,
    ) -> HandlerResult<State> {
        if ctx
            .object_client::<TengriWorkspaceRunsClient>(&admission.claim.workspace_uid)
            .latest_stop(Json(StopQuery {
                claim: admission.claim.clone(),
                known_id: String::new(),
            }))
            .call()
            .await?
            .into_inner()
            .is_some()
        {
            return Ok(State::Cancelled {
                turn_id: String::new(),
            });
        }
        Ok(ctx
            .run(|| async {
                Ok(Json(
                    self.service
                        .dispatch_durable_run(&admission.principal, &admission.input)
                        .await,
                ))
            })
            .name("dispatch_codex_turn")
            .await?
            .into_inner())
    }
}

struct TengriWorkspaceRuns {
    service: Arc<ControlPlane>,
}

#[object]
impl TengriWorkspaceRuns {
    #[handler(journal_retention = "1 minute", idempotency_retention = "0s")]
    async fn admit(
        &self,
        ctx: SharedObjectContext<'_>,
        envelope: Json<Envelope>,
    ) -> HandlerResult<()> {
        let workspace_uid = ctx.key().to_owned();
        let admission: Admission = ctx
            .run(|| async {
                let admission: Admission = open(&self.service, "admission", &envelope.0)
                    .await
                    .map_err(admission_error)?;
                if admission.claim.workspace_uid != workspace_uid
                    || admission.principal.context.workspace_uid != workspace_uid
                    || admission.claim.run_id != admission.input.id
                    || Uuid::parse_str(&admission.input.id).is_err()
                    || input_digest(&admission.input).map_err(terminal)? != admission.digest
                {
                    return Err(TerminalError::new_with_code(400, "invalid run identity").into());
                }
                Ok(Json(admission))
            })
            .await?
            .into_inner();
        let run_id = admission.input.id.clone();
        ctx.workflow_client::<TengriAgentRunClient>(&run_id)
            .run(Json(admission))
            .send()
            .await?;
        Ok(())
    }

    #[handler(journal_retention = "1 minute", idempotency_retention = "0s")]
    async fn admit_control(
        &self,
        ctx: SharedObjectContext<'_>,
        envelope: Json<Envelope>,
    ) -> HandlerResult<()> {
        let workspace_uid = ctx.key().to_owned();
        let control: Control = ctx
            .run(|| async {
                let control: Control = open(&self.service, "control", &envelope.0)
                    .await
                    .map_err(admission_error)?;
                if control.principal.context.workspace_uid != workspace_uid
                    || Uuid::parse_str(&control.id).is_err()
                    || Uuid::parse_str(&control.run_id).is_err()
                    || !matches!(
                        control.method.as_str(),
                        "turn/steer" | "turn/interrupt" | "tengri/resolveApproval"
                    )
                {
                    return Err(TerminalError::new_with_code(400, "invalid run control").into());
                }
                Ok(Json(control))
            })
            .await?
            .into_inner();
        let control_id = control.id.clone();
        ctx.workflow_client::<TengriRunControlClient>(&control_id)
            .run(Json(control))
            .send()
            .await?;
        Ok(())
    }

    #[handler(journal_retention = "0s", idempotency_retention = "0s")]
    async fn active(
        &self,
        ctx: SharedObjectContext<'_>,
        envelope: Json<Envelope>,
    ) -> HandlerResult<Json<Option<String>>> {
        let workspace = ctx.key().to_owned();
        ctx.run(|| async {
            let query: Query = open(&self.service, "active-query", &envelope.0)
                .await
                .map_err(terminal)?;
            if query.workspace_uid != workspace
                || query.expires_at_ms < crate::ofz::now_ms().map_err(terminal)?
            {
                return Err(TerminalError::new_with_code(403, "workspace unavailable").into());
            }
            Ok(())
        })
        .await?;
        Ok(Json(
            ctx.get::<Json<Claim>>("active")
                .await?
                .map(|claim| claim.0.run_id),
        ))
    }
    #[handler(ingress_private = true)]
    async fn store_stop(
        &self,
        ctx: ObjectContext<'_>,
        control: Json<Control>,
    ) -> HandlerResult<()> {
        let workspace_uid = ctx.key().to_owned();
        let control = control.into_inner();
        if control.principal.context.workspace_uid != workspace_uid
            || control.method != "turn/interrupt"
        {
            return Err(TerminalError::new_with_code(403, "workspace unavailable").into());
        }
        if ctx
            .get::<Json<Claim>>("active")
            .await?
            .is_none_or(|claim| claim.0.run_id != control.run_id)
        {
            return Err(TerminalError::new_with_code(409, "run is no longer active").into());
        }
        let previous = ctx.get::<Json<Control>>("stop").await?;
        if previous.as_ref().is_none_or(|previous| {
            previous.0.principal.context.deadline_unix_ms
                <= control.principal.context.deadline_unix_ms
        }) {
            ctx.set("stop", Json(control));
        }
        Ok(())
    }

    #[handler(
        ingress_private = true,
        journal_retention = "0s",
        idempotency_retention = "0s"
    )]
    async fn latest_stop(
        &self,
        ctx: ObjectContext<'_>,
        query: Json<StopQuery>,
    ) -> HandlerResult<Json<Option<Control>>> {
        if query.0.claim.workspace_uid != ctx.key()
            || ctx
                .get::<Json<Claim>>("active")
                .await?
                .is_none_or(|active| active.0 != query.0.claim)
        {
            return Err(TerminalError::new_with_code(403, "run is no longer active").into());
        }
        let stop = ctx
            .get::<Json<Control>>("stop")
            .await?
            .map(Json::into_inner)
            .filter(|control| {
                control.run_id == query.0.claim.run_id && control.id != query.0.known_id
            });
        Ok(Json(stop))
    }

    #[handler(ingress_private = true)]
    async fn claim(
        &self,
        ctx: ObjectContext<'_>,
        claim: Json<Claim>,
    ) -> HandlerResult<Json<Option<Control>>> {
        let active = ctx.get::<Json<Claim>>("active").await?;
        if active.as_ref().is_some_and(|active| active.0 == claim.0) {
            return Ok(Json(
                ctx.get::<Json<Control>>("stop")
                    .await?
                    .map(Json::into_inner),
            ));
        }
        if active.is_some() {
            return Err(
                TerminalError::new_with_code(409, "workspace already has an active run").into(),
            );
        }
        if claim.0.workspace_uid != ctx.key() || Uuid::parse_str(&claim.0.run_id).is_err() {
            return Err(TerminalError::new_with_code(400, "workspace binding changed").into());
        }
        ctx.clear("stop");
        ctx.set("active", claim);
        Ok(Json(None))
    }

    #[handler(ingress_private = true)]
    async fn release(&self, ctx: ObjectContext<'_>, claim: Json<Claim>) -> HandlerResult<()> {
        if claim.0.workspace_uid != ctx.key() {
            return Err(TerminalError::new_with_code(400, "workspace binding changed").into());
        }
        if ctx
            .get::<Json<Claim>>("active")
            .await?
            .is_some_and(|active| active.0 == claim.0)
        {
            ctx.clear("active");
            ctx.clear("stop");
        }
        Ok(())
    }
}

impl ControlPlane {
    async fn reconcile_durable_run(
        &self,
        principal: &Principal,
        input: &Input,
        state: &State,
    ) -> State {
        let Ok(guest) = self.run_guest(principal, input).await else {
            return state.clone();
        };
        match guest
            .codex_call(
                "tengri/reconcileOperation",
                serde_json::json!({"operationId":input.id,"threadId":input.thread_id}),
            )
            .await
        {
            Ok(value) => value
                .pointer("/turn/id")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
                .map(|turn_id| State::Running {
                    turn_id: turn_id.into(),
                })
                .unwrap_or_else(|| state.clone()),
            Err(crate::guest::GuestError::CodexOperationRejected) => State::Rejected {
                reason: "Codex rejected the operation before dispatch".into(),
            },
            Err(_) => state.clone(),
        }
    }
    async fn pin_run(
        &self,
        principal: &Principal,
        input: &Input,
        active: bool,
    ) -> Result<(), Status> {
        use kube::{
            Api, ResourceExt,
            api::{Patch, PatchParams},
        };
        let mut principal = principal.clone();
        principal.refresh_run_context()?;
        let api: Api<crate::crd::MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        let agent = if active {
            self.agent_access(&principal, &input.agent_id, &input.id)
                .await?
                .0
        } else {
            match api.get(&input.agent_id).await {
                Ok(agent) if agent.uid().as_deref() == Some(&principal.context.workspace_uid) => {
                    agent
                }
                Ok(_) => return Ok(()),
                Err(kube::Error::Api(error)) if error.code == 404 => return Ok(()),
                Err(_) => return Err(Status::unavailable("run sleep fence cleanup unavailable")),
            }
        };
        let current = agent
            .metadata
            .annotations
            .as_ref()
            .and_then(|a| a.get(crate::activity::ACTIVE_RUN_ANNOTATION));
        if current.is_some_and(|id| id != &input.id) {
            if !active {
                return Ok(());
            }
            return Err(Status::already_exists("workspace is pinned by another run"));
        }
        if (active && current == Some(&input.id)) || (!active && current.is_none()) {
            return Ok(());
        }
        let api: Api<crate::crd::MicroVM> = Api::namespaced(self.client.clone(), &self.namespace);
        let version = agent
            .resource_version()
            .ok_or_else(|| Status::unavailable("run sleep fence has no resource version"))?;
        let uid = agent
            .uid()
            .ok_or_else(|| Status::unavailable("run sleep fence has no workspace UID"))?;
        api.patch(&input.agent_id, &PatchParams::default(), &Patch::Merge(serde_json::json!({"metadata":{"uid":uid,"resourceVersion":version,"annotations":{crate::activity::ACTIVE_RUN_ANNOTATION: if active {Some(input.id.clone())} else {None}}}}))).await.map_err(|_| Status::unavailable("run sleep fence could not be recorded"))?;
        Ok(())
    }

    async fn run_guest(
        &self,
        principal: &Principal,
        input: &Input,
    ) -> Result<crate::guest::GuestClient, Status> {
        let mut principal = principal.clone();
        principal.refresh_run_context()?;
        self.guest(&principal, &input.agent_id, &input.thread_id)
            .await
    }

    async fn prepare_durable_run(&self, principal: &Principal, input: &Input) -> State {
        if let Err(error) = self.pin_run(principal, input, true).await {
            return if matches!(
                error.code(),
                tonic::Code::PermissionDenied | tonic::Code::Unauthenticated
            ) {
                State::Rejected {
                    reason: "run authority was revoked or expired before dispatch".into(),
                }
            } else {
                State::WaitingForGuest {
                    reason: "waiting to protect the active run from automatic sleep".into(),
                }
            };
        }
        let guest = match self.run_guest(principal, input).await {
            Ok(guest) => guest,
            Err(error)
                if matches!(
                    error.code(),
                    tonic::Code::PermissionDenied | tonic::Code::Unauthenticated
                ) =>
            {
                return State::Rejected {
                    reason: "run authority was revoked or expired before dispatch".into(),
                };
            }
            Err(_) => {
                return State::WaitingForGuest {
                    reason: "waiting for the authorized guest".into(),
                };
            }
        };
        for image in &input.images {
            if !guest
                .read_file(&image.path)
                .await
                .is_ok_and(|file| file.revision == image.revision)
            {
                return State::Rejected {
                    reason: "an accepted image is missing or changed".into(),
                };
            }
        }
        State::Accepted
    }

    async fn dispatch_durable_run(&self, principal: &Principal, input: &Input) -> State {
        if self.pin_run(principal, input, true).await.is_err() {
            return State::NeedsReconciliation {
                reason: "dispatch authority or its sleep fence is unavailable; a previous attempt may already have reached Codex".into(),
            };
        }
        let guest = match self.run_guest(principal, input).await {
            Ok(guest) => guest,
            Err(_) => {
                return State::NeedsReconciliation {
                    reason: "dispatch authority or transport is unavailable; a previous attempt may already have reached Codex".into(),
                };
            }
        };
        let mut parts = Vec::new();
        if !input.text.trim().is_empty() {
            parts.push(
                serde_json::json!({"type":"text","text":input.text.trim(),"text_elements":[]}),
            );
        }
        for image in &input.images {
            parts.push(serde_json::json!({"type":"localImage","path":image.path}));
        }
        let options = match crate::guest::CodexOptions::parse(
            input.model.clone(),
            input.reasoning_effort.clone(),
        ) {
            Ok(options) => options,
            Err(reason) => {
                return State::Rejected {
                    reason: reason.into(),
                };
            }
        };
        match guest
            .codex_call(
                "turn/start",
                serde_json::json!({
                    "threadId": input.thread_id, "clientUserMessageId": input.id,
                    "model": options.model, "effort": options.reasoning_effort, "input": parts,
                    "cwd": "/workspace", "runtimeWorkspaceRoots": ["/workspace"],
                    "approvalPolicy": "on-request", "sandboxPolicy": {"type": "dangerFullAccess"},
                }),
            )
            .await
        {
            Ok(value) => match value
                .pointer("/turn/id")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.is_empty())
            {
                Some(id) => State::Running { turn_id: id.into() },
                None => State::NeedsReconciliation {
                    reason: "Codex accepted a request without a turn identity".into(),
                },
            },
            Err(crate::guest::GuestError::CodexOperationRejected) => State::Rejected {
                reason: "Codex rejected the operation before dispatch".into(),
            },
            Err(_) => State::NeedsReconciliation {
                reason: "Codex dispatch outcome is uncertain; the request was not resent".into(),
            },
        }
    }

    async fn observe_durable_run(
        &self,
        principal: &Principal,
        input: &Input,
        state: &State,
    ) -> State {
        let Some(turn_id) = turn_id(state) else {
            return state.clone();
        };
        let guest = match self.run_guest(principal, input).await {
            Ok(guest) => guest,
            Err(error)
                if matches!(
                    error.code(),
                    tonic::Code::PermissionDenied | tonic::Code::Unauthenticated
                ) =>
            {
                return State::NeedsReconciliation {
                    reason: "run authority was revoked or expired".into(),
                };
            }
            Err(_) => {
                return State::Recovering {
                    turn_id: turn_id.to_owned(),
                    reason: "waiting for the authorized guest".into(),
                };
            }
        };
        let operation = guest.codex_call("tengri/operation", serde_json::json!({"threadId":input.thread_id,"operationId":input.id,"turnId":turn_id})).await.ok();
        if let Some(status) = operation
            .as_ref()
            .and_then(|value| value.get("terminalStatus"))
            .and_then(serde_json::Value::as_str)
            .filter(|status| matches!(*status, "completed" | "failed" | "interrupted"))
        {
            if status == "interrupted" {
                return State::Cancelled {
                    turn_id: turn_id.into(),
                };
            }
            return observed_turn(
                &serde_json::json!({"thread":{"turns":[{"id":turn_id,"status":status}]}}),
                turn_id,
            );
        }
        let metadata = match guest
            .codex_call(
                "thread/read",
                serde_json::json!({"threadId": input.thread_id, "includeTurns": false}),
            )
            .await
        {
            Ok(value) => value,
            Err(_) => {
                return State::Recovering {
                    turn_id: turn_id.to_owned(),
                    reason: "waiting for Codex thread state".into(),
                };
            }
        };
        let recorded = if metadata
            .pointer("/thread/historyMode")
            .and_then(serde_json::Value::as_str)
            == Some("paginated")
        {
            recorded_turn(&guest, &input.thread_id, turn_id).await
        } else {
            match guest
                .codex_call(
                    "thread/read",
                    serde_json::json!({"threadId":input.thread_id,"includeTurns":true}),
                )
                .await
            {
                Ok(value) => observed_turn(&value, turn_id),
                Err(_) => State::Recovering {
                    turn_id: turn_id.into(),
                    reason: "waiting for the recorded turn outcome".into(),
                },
            }
        };
        if matches!(
            recorded,
            State::Succeeded { .. } | State::NeedsReconciliation { .. } | State::Recovering { .. }
        ) {
            return recorded;
        }
        if !operation.as_ref().is_some_and(|value| {
            value
                .get("generationAlive")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        }) {
            return State::NeedsReconciliation {reason:"the Codex process that accepted this turn ended; external effects require reconciliation".into()};
        }
        if !matches!(recorded, State::Running { .. }) {
            return recorded;
        }
        if metadata
            .pointer("/thread/status/type")
            .and_then(serde_json::Value::as_str)
            == Some("active")
        {
            let approvals = match guest
                .codex_call(
                    "tengri/pending",
                    serde_json::json!({"threadId":input.thread_id}),
                )
                .await
                .and_then(|value| {
                    serde_json::from_value::<Vec<PendingApproval>>(value)
                        .map_err(crate::guest::GuestError::from)
                }) {
                Ok(approvals) => approvals,
                Err(_) => {
                    return State::Recovering {
                        turn_id: turn_id.into(),
                        reason: "pending controls could not be recovered".into(),
                    };
                }
            };
            if !approvals.is_empty() {
                return State::WaitingForApproval {
                    turn_id: turn_id.into(),
                    approvals,
                };
            }
            return State::Running {
                turn_id: turn_id.into(),
            };
        }
        State::NeedsReconciliation {
            reason: "the accepted turn is unfinished but its thread is no longer active".into(),
        }
    }

    async fn stop_durable_run(&self, control: &Control, input: &Input, state: &State) -> State {
        if matches!(state, State::Accepted | State::WaitingForGuest { .. }) {
            return State::Cancelled {
                turn_id: String::new(),
            };
        }
        let mut principal = control.principal.clone();
        if principal.refresh_run_context().is_ok()
            && let Ok((agent, _)) = self
                .agent_access(&principal, &input.agent_id, &input.id)
                .await
            && agent.spec.desired_state == crate::crd::MicroVMDesiredState::Sleeping
            && agent
                .status
                .as_ref()
                .is_some_and(|s| s.phase == crate::crd::MicroVMPhase::Sleeping)
        {
            return State::Cancelling {turn_id:turn_id(state).map(str::to_owned),reason:"Stop is recorded. The workspace is paused; resume it to confirm interruption of the preserved turn.".into()};
        }
        let recovered = if turn_id(state).is_none() {
            self.reconcile_durable_run(&control.principal, input, state)
                .await
        } else {
            state.clone()
        };
        let Some(turn) = turn_id(&recovered) else {
            return State::NeedsReconciliation {
                reason: "Stop is pending. The accepted turn could not be identified; reconcile its execution before starting new work.".into(),
            };
        };
        if let Ok(guest) = self.run_guest(&control.principal, input).await {
            let _ = guest.codex_call("turn/interrupt", serde_json::json!({"threadId":input.thread_id,"turnId":turn,"clientUserMessageId":control.id})).await;
        }
        let observed = self
            .observe_durable_run(
                &control.principal,
                input,
                &State::Running {
                    turn_id: turn.into(),
                },
            )
            .await;
        if observed.terminal() {
            return observed;
        }
        State::Cancelling {
            turn_id: Some(turn.into()),
            reason: "waiting for the exact turn to report a terminal outcome".into(),
        }
    }
}

fn turn_id(state: &State) -> Option<&str> {
    match state {
        State::Running { turn_id }
        | State::WaitingForApproval { turn_id, .. }
        | State::Recovering { turn_id, .. } => Some(turn_id),
        State::Cancelling { turn_id, .. } => turn_id.as_deref(),
        _ => None,
    }
}

async fn recorded_turn(guest: &crate::guest::GuestClient, thread: &str, turn: &str) -> State {
    let mut cursor = serde_json::Value::Null;
    let mut seen = std::collections::HashSet::new();
    let mut bytes = 0;
    for _ in 0..256 {
        let value = match guest.codex_call("thread/turns/list",serde_json::json!({"threadId":thread,"cursor":cursor,"limit":100,"sortDirection":"desc","itemsView":"notLoaded"})).await {
            Ok(value)=>value,
            Err(_)=>return State::Recovering{turn_id:turn.into(),reason:"waiting for the recorded turn outcome".into()},
        };
        bytes += value.to_string().len();
        if bytes > 64 << 20 {
            break;
        }
        let Some(data) = value.get("data").and_then(serde_json::Value::as_array) else {
            break;
        };
        if let Some(found) = data
            .iter()
            .find(|value| value.get("id").and_then(serde_json::Value::as_str) == Some(turn))
        {
            return observed_turn(&serde_json::json!({"thread":{"turns":[found]}}), turn);
        }
        match value.get("nextCursor") {
            Some(serde_json::Value::String(next))
                if !next.is_empty() && seen.insert(next.clone()) =>
            {
                cursor = serde_json::json!(next)
            }
            _ => break,
        }
    }
    State::NeedsReconciliation {
        reason: "the accepted turn has no authoritative outcome in the bounded history".into(),
    }
}

fn observed_turn(value: &serde_json::Value, turn_id: &str) -> State {
    let turn = value
        .pointer("/thread/turns")
        .and_then(serde_json::Value::as_array)
        .and_then(|turns| {
            turns
                .iter()
                .find(|turn| turn.get("id").and_then(serde_json::Value::as_str) == Some(turn_id))
        });
    match turn
        .and_then(|turn| turn.get("status"))
        .and_then(serde_json::Value::as_str)
    {
        Some("completed") => State::Succeeded {
            turn_id: turn_id.into(),
        },
        Some("failed") => State::Failed {
            turn_id: turn_id.into(),
            reason: "Codex reported a failed turn".into(),
        },
        Some("interrupted") => State::Cancelling {
            turn_id: Some(turn_id.into()),
            reason: "waiting for the interrupted turn's command cleanup receipt".into(),
        },
        Some("inProgress") => State::Running {
            turn_id: turn_id.into(),
        },
        _ => State::NeedsReconciliation {
            reason: "the accepted turn has no authoritative outcome".into(),
        },
    }
}

fn admission_error(status: Status) -> TerminalError {
    if status.code() == tonic::Code::Unauthenticated {
        TerminalError::new_with_code(
            503,
            "durable admission key changed; retry the same operation",
        )
    } else {
        terminal(status)
    }
}

fn terminal(status: Status) -> TerminalError {
    let code = match status.code() {
        tonic::Code::InvalidArgument => 400,
        tonic::Code::Unauthenticated => 401,
        tonic::Code::PermissionDenied => 403,
        tonic::Code::AlreadyExists | tonic::Code::FailedPrecondition => 409,
        _ => 503,
    };
    TerminalError::new_with_code(code, status.message())
}

pub(crate) async fn serve(service: ControlPlane) -> anyhow::Result<()> {
    let key = env::var("RESTATE_REQUEST_IDENTITY_KEYS")?;
    let service = Arc::new(service);
    let endpoint = Endpoint::builder()
        .identity_key(&key)?
        .bind(
            TengriAgentRun {
                service: service.clone(),
            }
            .into_service_definition()
            .options(
                restate_sdk::endpoint::ServiceOptions::default()
                    .journal_retention(Duration::from_secs(7 * 24 * 60 * 60))
                    .idempotency_retention(Duration::from_secs(7 * 24 * 60 * 60)),
            ),
        )
        .bind(
            TengriRunControl.into_service_definition().options(
                restate_sdk::endpoint::ServiceOptions::default()
                    .journal_retention(Duration::from_secs(7 * 24 * 60 * 60))
                    .idempotency_retention(Duration::from_secs(7 * 24 * 60 * 60)),
            ),
        )
        .bind(
            TengriWorkspaceRuns { service }
                .into_service_definition()
                .options(restate_sdk::endpoint::ServiceOptions::default()),
        )
        .build();
    let listener = tokio::net::TcpListener::bind("0.0.0.0:9080").await?;
    HttpServer::new(endpoint)
        .serve_with_cancel(listener, async {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("install termination handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        })
        .await;
    Ok(())
}

#[cfg(test)]
mod tests;
