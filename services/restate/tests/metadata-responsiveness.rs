
#[cfg(test)]
mod background_write_regression {
    use super::RocksDbStorage;
    use raft_proto::eraftpb::HardState;
    use restate_rocksdb::RocksDbManager;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Requires the isolated Linux fsync injector; ordinary upstream tests never enable it.
    #[restate_core::test(flavor = "current_thread")]
    #[ignore]
    async fn metadata_sync_keeps_timers_and_network_responsive() {
        RocksDbManager::init();
        let mut storage = RocksDbStorage::create().await.unwrap();
        let mut state = HardState::default();
        state.set_term(42);
        state.set_vote(1);
        storage.store_hard_state(state.clone()).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        std::fs::write("/proof/armed", b"armed").unwrap();
        state.set_term(43);
        let started = Instant::now();
        let (timer_elapsed, network_elapsed, ()) = tokio::join!(
            async {
                tokio::time::sleep(Duration::from_millis(25)).await;
                started.elapsed()
            },
            async {
                let (server, client) = tokio::join!(
                    async {
                        let (mut socket, _) = listener.accept().await.unwrap();
                        let mut data = [0; 4];
                        socket.read_exact(&mut data).await.unwrap();
                        socket.write_all(&data).await.unwrap();
                    },
                    async {
                        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
                        socket.write_all(b"ping").await.unwrap();
                        let mut data = [0; 4];
                        socket.read_exact(&mut data).await.unwrap();
                        assert_eq!(&data, b"ping");
                    }
                );
                let _ = (server, client);
                started.elapsed()
            },
            async { storage.store_hard_state(state.clone()).await.unwrap() }
        );
        std::fs::remove_file("/proof/armed").unwrap();
        let injections = std::fs::read_to_string("/proof/injected").unwrap();
        assert!(injections.contains("wal-sync"), "fsync injector did not run");
        assert!(started.elapsed() >= Duration::from_secs(2), "write was not delayed");
        assert_eq!(storage.get_hard_state().unwrap(), state);
        drop(storage);
        RocksDbManager::get().reset().await.unwrap();
        let storage = RocksDbStorage::create().await.unwrap();
        assert_eq!(storage.get_hard_state().unwrap(), state, "durable state lost on reopen");
        drop(storage);
        RocksDbManager::get().shutdown().await;
        println!("timer_ms={} network_ms={} write_ms={}", timer_elapsed.as_millis(), network_elapsed.as_millis(), started.elapsed().as_millis());
        assert!(timer_elapsed < Duration::from_secs(1), "ASYNC_WORKER_BLOCKED: timer={timer_elapsed:?}");
        assert!(network_elapsed < Duration::from_secs(1), "ASYNC_WORKER_BLOCKED: network={network_elapsed:?}");
    }
}
