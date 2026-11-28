
// Appended only after the baseline proof and only in the Docker test stage.
#[cfg(test)]
mod cold_election_safety_proof {
    use super::*;
    use super::cold_election_connection_proof::{emit_campaign, fixture, tick_once};
    use restate_rocksdb::RocksDbManager;

    #[restate_core::test(flavor = "current_thread")]
    async fn same_term_pre_campaign_replaces_all_old_requests() {
        let (mut member, _listener, manager, _core) = fixture().await;
        emit_campaign(&mut member, false).await;
        let old_campaign = member.election_campaign;
        let old_term = member.raw_node.raft.term;
        for pending in member.pending_election_messages.values_mut() {
            pending.message.context = b"stale campaign".to_vec().into();
        }
        // A second PreCandidate campaign has the same role and term but must replace the queue.
        let expected = emit_campaign(&mut member, false).await;
        assert_eq!(member.raw_node.raft.term, old_term);
        assert!(member.election_campaign > old_campaign);
        assert_eq!(member.pending_election_messages.len(), 2);
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 8);
        tick_once(&mut member).await;
        let actual = <Message as ProtobufMessage>::parse_from_bytes(
            &outgoing.try_recv().unwrap().payload).unwrap();
        assert_eq!(actual, expected);
        assert!(outgoing.try_recv().is_err());
        drop(member);
        RocksDbManager::get().shutdown().await;
    }

    #[restate_core::test(flavor = "current_thread")]
    async fn successful_new_campaign_also_discards_old_pending_requests() {
        let (mut member, _listener, manager, _core) = fixture().await;
        emit_campaign(&mut member, false).await;
        let old_campaign = member.election_campaign;
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 8);
        let _other = manager.proof_install_connection(PlainNodeId::from(3_u32), 8);
        member.raw_node.campaign().unwrap();
        let nodes = Metadata::with_current(|m| m.nodes_config_ref().clone());
        member.on_ready(&nodes).await.unwrap();
        assert!(member.election_campaign > old_campaign);
        assert!(member.pending_election_messages.is_empty());
        assert!(outgoing.try_recv().is_ok());
        assert!(outgoing.try_recv().is_err(), "old campaign was also retransmitted");
        drop(member);
        RocksDbManager::get().shutdown().await;
    }

    #[restate_core::test(flavor = "current_thread")]
    async fn stale_role_term_and_membership_are_discarded() {
        let (mut member, _listener, manager, _core) = fixture().await;
        emit_campaign(&mut member, false).await;
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 8);
        // An accepted leader message changes role even without changing the term.
        let term = member.raw_node.raft.term;
        member.raw_node.raft.become_follower(term, 3);
        member.retry_pending_election_messages();
        assert!(member.pending_election_messages.is_empty());
        assert!(outgoing.try_recv().is_err());
        manager.proof_remove_connection(PlainNodeId::from(2_u32));
        emit_campaign(&mut member, false).await;
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 8);
        member.raw_node.raft.term += 1;
        member.retry_pending_election_messages();
        assert!(member.pending_election_messages.is_empty());
        assert!(outgoing.try_recv().is_err());
        manager.proof_remove_connection(PlainNodeId::from(2_u32));
        let term = member.raw_node.raft.term;
        member.raw_node.raft.become_follower(term, 0);
        emit_campaign(&mut member, false).await;
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 8);
        member.configuration.version = member.configuration.version.next();
        member.retry_pending_election_messages();
        assert!(member.pending_election_messages.is_empty());
        assert!(outgoing.try_recv().is_err());
        drop(member);
        RocksDbManager::get().shutdown().await;
    }

    #[restate_core::test(flavor = "current_thread")]
    async fn removed_voters_cannot_send_or_receive_deferred_requests() {
        let (mut member, _listener, manager, _core) = fixture().await;
        emit_campaign(&mut member, false).await;
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 8);
        // Even before the metadata configuration version changes, current Raft membership wins.
        let mut remove = ConfChangeSingle::default();
        remove.node_id = 2;
        remove.change_type = ConfChangeType::RemoveNode;
        let mut change = ConfChangeV2::default();
        change.set_changes(vec![remove].into());
        member.raw_node.apply_conf_change(&change).unwrap();
        member.retry_pending_election_messages();
        assert!(!member.pending_election_messages.contains_key(&2));
        assert!(outgoing.try_recv().is_err());
        // Removal of this sender must also invalidate any surviving target's queued request.
        let mut remove = ConfChangeSingle::default();
        remove.node_id = 1;
        remove.change_type = ConfChangeType::RemoveNode;
        change.set_changes(vec![remove].into());
        member.raw_node.apply_conf_change(&change).unwrap();
        member.retry_pending_election_messages();
        assert!(member.pending_election_messages.is_empty());
        drop(member);
        RocksDbManager::get().shutdown().await;
    }

    #[restate_core::test(flavor = "current_thread")]
    async fn expiry_is_bounded_and_failed_peer_does_not_block_healthy_peer() {
        let (mut member, _listener, manager, _core) = fixture().await;
        let emitted_at = time::Instant::now();
        let expected = emit_campaign(&mut member, false).await;
        assert_eq!(member.pending_election_messages.len(), 2);
        let connect_budget: std::time::Duration = Configuration::pinned().networking.connect_timeout.into();
        let max_age = connect_budget.min(std::time::Duration::from_secs(10));
        let captured_at = time::Instant::now();
        for pending in member.pending_election_messages.values() {
            assert!(pending.expires_at >= emitted_at + max_age);
            assert!(pending.expires_at <= captured_at + max_age);
        }
        let attempts = member.networking.proof_connection_attempt_count();
        let deadline = member.pending_election_messages[&2].expires_at;
        // Repeated readiness checks neither grow the queue nor extend its deadline or reconnect.
        for _ in 0..100 {
            member.retry_pending_election_messages();
        }
        assert_eq!(member.pending_election_messages.len(), 2);
        assert_eq!(member.pending_election_messages[&2].expires_at, deadline);
        assert_eq!(member.networking.proof_connection_attempt_count(), attempts);
        member.pending_election_messages.get_mut(&3).unwrap().expires_at = time::Instant::now();
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 8);
        tick_once(&mut member).await;
        assert!(member.pending_election_messages.is_empty());
        let actual = <Message as ProtobufMessage>::parse_from_bytes(
            &outgoing.try_recv().unwrap().payload).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(member.networking.proof_connection_attempt_count(), attempts);
        drop(member);
        RocksDbManager::get().shutdown().await;
    }

    #[restate_core::test(flavor = "current_thread")]
    async fn full_and_closed_channels_are_not_requeued() {
        let (mut member, _listener, manager, _core) = fixture().await;
        let request = emit_campaign(&mut member, false).await;
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 1);
        member.networking.try_send_ready(request.clone()).unwrap();
        tick_once(&mut member).await;
        assert!(!member.pending_election_messages.contains_key(&2));
        assert!(outgoing.try_recv().is_ok());
        member.retry_pending_election_messages();
        assert!(outgoing.try_recv().is_err(), "full-channel request was retained");
        manager.proof_remove_connection(PlainNodeId::from(2_u32));
        emit_campaign(&mut member, false).await;
        let outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 1);
        drop(outgoing);
        member.retry_pending_election_messages();
        assert!(!member.pending_election_messages.contains_key(&2));
        drop(member);
        RocksDbManager::get().shutdown().await;
    }

    #[restate_core::test(flavor = "current_thread")]
    async fn ordinary_messages_are_not_queued_and_ready_only_send_never_connects() {
        let (mut member, _listener, manager, _core) = fixture().await;
        let mut message = Message::default();
        message.from = 1;
        message.to = 2;
        message.term = 1;
        for kind in [MessageType::MsgAppend, MessageType::MsgHeartbeat,
            MessageType::MsgRequestPreVoteResponse, MessageType::MsgRequestVoteResponse] {
            message.set_msg_type(kind);
            member.send_messages(vec![message.clone()]);
            assert!(member.pending_election_messages.is_empty());
        }
        let attempts = member.networking.proof_connection_attempt_count();
        message.to = 3;
        assert!(matches!(member.networking.try_send_ready(message.clone()),
            Err(TrySendError::Connecting(_))));
        assert_eq!(member.networking.proof_connection_attempt_count(), attempts);
        let receiver = manager.proof_install_connection(PlainNodeId::from(3_u32), 1);
        drop(receiver);
        assert!(matches!(member.networking.try_send_ready(message),
            Err(TrySendError::Send(_))));
        assert_eq!(member.networking.proof_connection_attempt_count(), attempts);
        drop(member);
        RocksDbManager::get().shutdown().await;
    }

    #[restate_core::test(flavor = "current_thread")]
    async fn address_changes_discard_deferred_request() {
        let (mut member, _listener, manager, _core) = fixture().await;
        emit_campaign(&mut member, false).await;
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 8);
        let mut nodes = NodesConfiguration::new_for_testing();
        nodes.set_version(Version::MIN.next());
        nodes.upsert_node(restate_types::nodes_config::NodeConfig {
            name: "changed-peer".to_owned(),
            current_generation: restate_types::GenerationalNodeId::new(2, 1),
            address: "http://127.0.0.1:1".parse().unwrap(),
            ctrl_address: None,
            roles: Role::MetadataServer.into(),
            log_server_config: Default::default(),
            location: Default::default(),
            metadata_server_config: Default::default(),
            worker_config: Default::default(),
            binary_version: None,
        });
        member.update_node_addresses(&nodes);
        assert!(!member.pending_election_messages.contains_key(&2));
        assert!(member.pending_election_messages.contains_key(&3));
        member.retry_pending_election_messages();
        assert!(outgoing.try_recv().is_err());
        drop(member);
        RocksDbManager::get().shutdown().await;
    }

    #[restate_core::test(flavor = "current_thread")]
    async fn cold_snapshot_keeps_existing_failure_reporting() {
        let (mut member, _listener, manager, _core) = fixture().await;
        emit_campaign(&mut member, true).await;
        let mut response = Message::default();
        response.set_msg_type(MessageType::MsgRequestVoteResponse);
        response.from = 2;
        response.to = 1;
        response.term = member.raw_node.raft.term;
        member.raw_node.step(response).unwrap();
        let nodes = Metadata::with_current(|m| m.nodes_config_ref().clone());
        member.on_ready(&nodes).await.unwrap();
        assert_eq!(member.raw_node.raft.state, StateRole::Leader);
        assert!(member.pending_election_messages.is_empty(), "candidate work survived leadership");
        let progress = member.raw_node.raft.mut_prs().get_mut(2).unwrap();
        let probe = progress.state;
        progress.become_snapshot(5);
        assert_ne!(progress.state, probe);
        let mut snapshot = Snapshot::default();
        snapshot.mut_metadata().index = 5;
        let mut message = Message::default();
        message.set_msg_type(MessageType::MsgSnapshot);
        message.from = 1;
        message.to = 2;
        message.term = 1;
        message.set_snapshot(snapshot);
        member.send_messages(vec![message.clone()]);
        assert!(member.pending_election_messages.is_empty());
        assert_eq!(member.raw_node.raft.prs().get(2).unwrap().state, probe,
            "cold snapshot must report Failure, never queued-success");
        let progress = member.raw_node.raft.prs().get(2).unwrap();
        assert_eq!(progress.next_idx, progress.matched + 1,
            "Failure must not advance progress past the unaccepted snapshot");
        member.raw_node.raft.mut_prs().get_mut(2).unwrap().become_snapshot(5);
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 1);
        member.send_messages(vec![message.clone()]);
        let actual = <Message as ProtobufMessage>::parse_from_bytes(
            &outgoing.try_recv().unwrap().payload).unwrap();
        assert_eq!(actual, message);
        assert_eq!(member.raw_node.raft.prs().get(2).unwrap().state, probe,
            "ready snapshot must keep existing Finish reporting");
        let progress = member.raw_node.raft.prs().get(2).unwrap();
        assert_eq!(progress.next_idx, (progress.matched + 1).max(6),
            "Finish must retain the accepted snapshot index");
        drop(member);
        RocksDbManager::get().shutdown().await;
    }
}
