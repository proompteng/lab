use super::*;
use kube::client::Body as KubeBody;

#[tokio::test]
async fn idle_preview_websockets_keep_both_hops_alive_without_user_activity() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio_tungstenite::{accept_async, connect_async};

    let writes = Arc::new(AtomicUsize::new(0));
    let counted = writes.clone();
    let client = Client::new(
        tower::service_fn(move |_: Request<KubeBody>| {
            counted.fetch_add(1, Ordering::SeqCst);
            async {
                Ok::<_, std::convert::Infallible>(Response::new(KubeBody::from(b"{}".to_vec())))
            }
        }),
        "tengri",
    );
    let activity = ActivityTracker::new(client, "tengri".into());
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream.local_addr().unwrap();
    let (ping, received_ping) = tokio::sync::oneshot::channel();
    let upstream_task = tokio::spawn(async move {
        let (connection, _) = upstream.accept().await.unwrap();
        let mut socket = accept_async(connection).await.unwrap();
        let mut ping = Some(ping);
        while let Some(Ok(message)) = socket.next().await {
            match message {
                TungsteniteMessage::Ping(data) => {
                    if let Some(ping) = ping.take() {
                        let _ = ping.send(());
                    }
                    if socket.send(TungsteniteMessage::Pong(data)).await.is_err() {
                        break;
                    }
                }
                TungsteniteMessage::Binary(data) => {
                    if socket.send(TungsteniteMessage::Binary(data)).await.is_err() {
                        break;
                    }
                }
                TungsteniteMessage::Pong(data) if data.as_ref() == b"browser keepalive" => {
                    if socket
                        .send(TungsteniteMessage::Pong(b"round trip".to_vec().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                _ => {}
            }
        }
    });
    let started = Arc::new(tokio::sync::Notify::new());
    let connected = started.clone();
    let router = Router::new().route(
        "/",
        get(move |upgrade: WebSocketUpgrade| {
            let activity = activity.clone();
            let connected = connected.clone();
            async move {
                upgrade.on_upgrade(move |browser| async move {
                    let (upstream, _) = connect_async(format!("ws://{upstream_address}/"))
                        .await
                        .unwrap();
                    connected.notify_one();
                    bridge_open_websocket(browser, upstream, activity, "agent-test".into()).await;
                })
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let (mut browser, _) = connect_async(format!("ws://{address}/")).await.unwrap();
    started.notified().await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(21)).await;
    tokio::time::resume();
    let upstream_ping = tokio::time::timeout(Duration::from_millis(500), received_ping).await;
    let browser_ping = tokio::time::timeout(Duration::from_millis(500), async {
        while let Some(Ok(message)) = browser.next().await {
            if matches!(message, TungsteniteMessage::Ping(_)) {
                return true;
            }
        }
        false
    })
    .await;
    browser
        .send(TungsteniteMessage::Pong(
            b"browser keepalive".to_vec().into(),
        ))
        .await
        .unwrap();
    let control_round_trip = tokio::time::timeout(Duration::from_millis(500), async {
        while let Some(Ok(message)) = browser.next().await {
            if matches!(message, TungsteniteMessage::Pong(data) if data.as_ref() == b"round trip") {
                return true;
            }
        }
        false
    })
    .await;
    let heartbeat_writes = writes.load(Ordering::SeqCst);
    browser
        .send(TungsteniteMessage::Binary(
            b"preview payload".to_vec().into(),
        ))
        .await
        .unwrap();
    let echoed = tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(Ok(message)) = browser.next().await {
            if let TungsteniteMessage::Binary(data) = message {
                return data.to_vec();
            }
        }
        Vec::new()
    })
    .await;
    let _ = browser.close(None).await;
    server.abort();
    upstream_task.abort();
    assert!(
        matches!(upstream_ping, Ok(Ok(()))),
        "idle guest hop received no keepalive"
    );
    assert!(
        matches!(browser_ping, Ok(true)),
        "idle browser hop received no keepalive"
    );
    assert_eq!(
        heartbeat_writes, 0,
        "transport keepalives must not postpone automatic sleep"
    );
    assert!(matches!(control_round_trip, Ok(true)));
    assert_eq!(echoed.unwrap(), b"preview payload");
}
