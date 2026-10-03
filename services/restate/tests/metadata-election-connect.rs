
// Appended only in the Docker test stage, unchanged for baseline and patched source.
#[cfg(test)]
mod cold_election_connection_proof {
    use super::*;
    use restate_rocksdb::RocksDbManager;
    use tokio::net::TcpListener;
    use tokio::sync::watch;

    pub(super) async fn fixture() -> (
        Member,
        TcpListener,
        Arc<ConnectionManager<Message>>,
        restate_core::TestCoreEnv<restate_core::network::FailingConnector>,
    ) {
        // The test macro creates the task center, but Member also needs its global metadata
        // and address book. Use the upstream in-memory environment; no live service is used.
        let core = restate_core::TestCoreEnv::create_with_single_node(1, 1).await;
        assert!(TaskCenter::try_set_address_book(
            restate_types::net::listener::AddressBook::new(std::path::PathBuf::new()),
        ));
        RocksDbManager::init();
        let storage = RocksDbStorage::create().await.unwrap();
        let (_, request_rx) = mpsc::channel(1);
        let (_, join_rx) = mpsc::channel(1);
        let (_, command_rx) = mpsc::channel(1);
        let (status_tx, _) = watch::channel(MetadataServerSummary::default());
        let mut member = Member::create(
            MemberId::new(PlainNodeId::from(1_u32), 1),
            Version::INVALID,
            Arc::default(),
            storage,
            request_rx,
            join_rx,
            None,
            status_tx,
            command_rx,
        ).unwrap();
        let mut change = ConfChangeV2::default();
        change.set_changes((1..=3).map(|id| {
            let mut entry = ConfChangeSingle::default();
            entry.node_id = id;
            entry.change_type = ConfChangeType::AddNode;
            entry
        }).collect::<Vec<_>>().into());
        member.raw_node.apply_conf_change(&change).unwrap();
        for id in 1_u32..=3 {
            member.configuration.members.insert(PlainNodeId::from(id), 1);
        }
        // No external service is contacted. This loopback listener deliberately never completes
        // the metadata handshake; installing a channel below is the controlled readiness barrier.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        for id in [2_u32, 3] {
            member.networking.register_address(PlainNodeId::from(id), address.parse().unwrap());
        }
        let manager = Arc::clone(member.connection_manager.load().as_ref().unwrap());
        (member, listener, manager, core)
    }

    pub(super) async fn emit_campaign(member: &mut Member, vote: bool) -> Message {
        member.raw_node.campaign().unwrap();
        let kind = if vote {
            let mut response = Message::default();
            response.set_msg_type(MessageType::MsgRequestPreVoteResponse);
            response.from = 2;
            response.to = 1;
            response.term = member.raw_node.raft.term + 1;
            member.raw_node.step(response).unwrap();
            MessageType::MsgRequestVote
        } else {
            MessageType::MsgRequestPreVote
        };
        let expected = member.raw_node.raft.msgs.iter()
            .find(|message| message.to == 2 && message.get_msg_type() == kind)
            .expect("Raft did not produce the expected campaign request").clone();
        let nodes_config = Metadata::with_current(|m| m.nodes_config_ref().clone());
        member.on_ready(&nodes_config).await.unwrap();
        assert!(member.networking.proof_has_connection_attempt(PlainNodeId::from(2_u32)),
            "COLD_PEER_WRONG_BRANCH: expected a real connection attempt, not UnknownPeer");
        assert!(member.connection_manager.load().as_ref().unwrap()
            .get_connection(PlainNodeId::from(2_u32)).is_none());
        assert_eq!(member.raw_node.store().get_hard_state().unwrap().get_term(), member.raw_node.raft.term,
            "hard state must be durable before deferred campaign delivery");
        if vote {
            assert_eq!(member.raw_node.store().get_hard_state().unwrap().get_vote(), 1,
                "the self vote must be durable before deferred Vote delivery");
            assert_eq!(member.raw_node.raft.vote, 1);
        }
        println!("COLD_PEER_BRANCH_CONFIRMED: {:?}", kind);
        expected
    }

    pub(super) async fn tick_once(member: &mut Member) {
        let term = member.raw_node.raft.term;
        let state = member.raw_node.raft.state;
        member.raw_node.tick();
        assert_eq!(member.raw_node.raft.term, term);
        assert_eq!(member.raw_node.raft.state, state);
        assert!(member.raw_node.raft.msgs.is_empty(), "test accidentally started another campaign");
        let nodes_config = Metadata::with_current(|m| m.nodes_config_ref().clone());
        member.on_ready(&nodes_config).await.unwrap();
    }

    async fn cold_request_is_delivered(vote: bool) {
        let (mut member, _listener, manager, _core) = fixture().await;
        let expected = emit_campaign(&mut member, vote).await;
        let mut outgoing = manager.proof_install_connection(PlainNodeId::from(2_u32), 8);
        tick_once(&mut member).await;
        let packet = outgoing.try_recv()
            .expect("COLD_PEER_CAMPAIGN_DROPPED: connection became ready without another election");
        let actual = <Message as ProtobufMessage>::parse_from_bytes(&packet.payload).unwrap();
        assert_eq!(actual, expected, "the exact Raft-emitted request must reach transport");
        assert!(outgoing.try_recv().is_err(), "request was duplicated");
        println!("COLD_PEER_DELIVERED: {:?}, term={}, one tick, no new campaign",
            actual.get_msg_type(), actual.term);
        drop(member);
        RocksDbManager::get().shutdown().await;
    }

    #[restate_core::test(flavor = "current_thread")]
    async fn cold_pre_vote_reaches_transport_without_new_campaign() {
        cold_request_is_delivered(false).await;
    }

    #[restate_core::test(flavor = "current_thread")]
    async fn cold_vote_reaches_transport_after_hard_state_persistence() {
        cold_request_is_delivered(true).await;
    }
}
