use super::*;
use crate::guest::rpc::{RpcClient, proto};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

pub(super) fn attachment(id: &str, query: &[(String, String)]) -> proto::TerminalAttach {
    let value = |name: &str| {
        query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    proto::TerminalAttach {
        id: id.into(),
        reconnect_token: value("reconnect").unwrap_or_default().into(),
        since: value("since")
            .and_then(|value| value.parse().ok())
            .unwrap_or_default(),
        columns: value("cols")
            .and_then(|value| value.parse::<u16>().ok())
            .map(u32::from)
            .unwrap_or_default(),
        rows: value("rows")
            .and_then(|value| value.parse::<u16>().ok())
            .map(u32::from)
            .unwrap_or_default(),
    }
}

pub(super) async fn bridge(
    mut browser: axum::extract::ws::WebSocket,
    rpc: RpcClient,
    attach: proto::TerminalAttach,
    activity: ActivityTracker,
    agent_id: String,
) {
    let (sender, receiver) = mpsc::channel(1);
    if sender
        .send(proto::TerminalInput {
            action: Some(proto::terminal_input::Action::Attach(attach)),
        })
        .await
        .is_err()
    {
        return;
    }
    let mut outputs = match rpc.attach_terminal(ReceiverStream::new(receiver)).await {
        Ok(outputs) => outputs,
        Err(error) => {
            report_error(&mut browser, &error.to_string()).await;
            let _ = browser.close().await;
            return;
        }
    };
    loop {
        tokio::select! {
            message = browser.recv() => {
                let Some(Ok(message)) = message else { break };
                activity.touch(&agent_id);
                if matches!(message, AxumMessage::Close(_)) { break; }
                if let Some(input) = input(message) && sender.send(input).await.is_err() { break; }
            }
            message = outputs.message() => {
                let message = match message {
                    Ok(Some(message)) => message,
                    Ok(None) => break,
                    Err(error) => {
                        report_error(&mut browser, &crate::guest::rpc::rpc_error(error).to_string()).await;
                        break;
                    }
                };
                let Some(message) = output(message) else { break };
                activity.touch(&agent_id);
                if browser.send(message).await.is_err() { break; }
            }
        }
    }
    let _ = browser.close().await;
}

async fn report_error(browser: &mut axum::extract::ws::WebSocket, message: &str) {
    let value = serde_json::json!({"type": "error", "message": message});
    let _ = browser
        .send(AxumMessage::Text(value.to_string().into()))
        .await;
}

fn input(message: AxumMessage) -> Option<proto::TerminalInput> {
    use proto::terminal_input::Action;
    let action = match message {
        AxumMessage::Binary(bytes) => Action::Input(bytes.to_vec()),
        AxumMessage::Text(text) => {
            #[derive(serde::Deserialize)]
            struct Control {
                #[serde(rename = "type")]
                kind: String,
                #[serde(default)]
                cols: u16,
                #[serde(default)]
                rows: u16,
                #[serde(default)]
                signal: String,
            }
            let control: Control = serde_json::from_str(&text).ok()?;
            match control.kind.as_str() {
                "resize" => Action::Resize(proto::TerminalResize {
                    columns: control.cols.into(),
                    rows: control.rows.into(),
                }),
                "signal" => Action::Signal(control.signal),
                "ping" => Action::Ping(proto::Empty {}),
                "terminate" => Action::Terminate(proto::Empty {}),
                _ => return None,
            }
        }
        _ => return None,
    };
    Some(proto::TerminalInput {
        action: Some(action),
    })
}

fn output(message: proto::TerminalOutput) -> Option<AxumMessage> {
    use proto::terminal_output::Event;
    let value = match message.event? {
        Event::Ready(value) => {
            serde_json::json!({"type":"ready", "sessionId":value.session_id, "token":value.token, "bufferStart":value.buffer_start, "bufferEnd":value.buffer_end})
        }
        Event::Reset(value) => {
            serde_json::json!({"type":"reset", "reason":value.reason, "bufferStart":value.buffer_start, "bufferEnd":value.buffer_end})
        }
        Event::ExitCode(value) => serde_json::json!({"type":"exit", "exitCode":value}),
        Event::Error(value) => serde_json::json!({"type":"error", "message":value}),
        Event::Pong(_) => serde_json::json!({"type":"pong"}),
        Event::Output(value) => {
            if value.data.len().saturating_add(5) > MAX_WEBSOCKET_MESSAGE {
                return None;
            }
            let mut frame = Vec::with_capacity(value.data.len() + 5);
            frame.push(1);
            frame.extend_from_slice(&value.sequence.to_be_bytes());
            frame.extend_from_slice(&value.data);
            return Some(AxumMessage::Binary(frame.into()));
        }
    };
    Some(AxumMessage::Text(value.to_string().into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_frames_preserve_bytes_sequences_and_control_fields() {
        let frame = output(proto::TerminalOutput {
            event: Some(proto::terminal_output::Event::Output(proto::TerminalData {
                sequence: 0x01020304,
                data: vec![0, 255, 128],
            })),
        })
        .unwrap();
        assert_eq!(
            frame,
            AxumMessage::Binary(vec![1, 1, 2, 3, 4, 0, 255, 128].into())
        );
        let frame = output(proto::TerminalOutput {
            event: Some(proto::terminal_output::Event::Ready(proto::TerminalReady {
                session_id: "session".into(),
                token: "reconnect".into(),
                buffer_start: 7,
                buffer_end: 42,
            })),
        })
        .unwrap();
        let AxumMessage::Text(text) = frame else {
            panic!("expected control frame")
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            serde_json::json!({
                "type":"ready", "sessionId":"session", "token":"reconnect", "bufferStart":7, "bufferEnd":42,
            })
        );
        let input = input(AxumMessage::Binary(vec![0, 255, 128].into())).unwrap();
        assert_eq!(
            input.action,
            Some(proto::terminal_input::Action::Input(vec![0, 255, 128]))
        );
        let input = super::input(AxumMessage::Text(
            r#"{"type":"resize","cols":120,"rows":40}"#.into(),
        ))
        .unwrap();
        assert_eq!(
            input.action,
            Some(proto::terminal_input::Action::Resize(
                proto::TerminalResize {
                    columns: 120,
                    rows: 40
                }
            ))
        );
        assert!(
            super::input(AxumMessage::Text(
                r#"{"type":"resize","cols":65536}"#.into()
            ))
            .is_none()
        );
    }

    #[test]
    fn reconnect_cursor_and_dimensions_keep_the_existing_query_contract() {
        let attach = attachment(
            "session",
            &[
                ("reconnect".into(), "token".into()),
                ("since".into(), "42".into()),
                ("cols".into(), "100".into()),
                ("rows".into(), "30".into()),
            ],
        );
        assert_eq!(
            (
                attach.id.as_str(),
                attach.reconnect_token.as_str(),
                attach.since,
                attach.columns,
                attach.rows
            ),
            ("session", "token", 42, 100, 30)
        );
    }
}
