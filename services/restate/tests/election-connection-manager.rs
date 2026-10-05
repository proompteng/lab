
// Test-stage-only readiness barrier. Uses the production Connection and outgoing channel.
#[cfg(test)]
impl<M> ConnectionManager<M>
where
    M: NetworkMessage + Send + 'static,
{
    pub(crate) fn proof_install_connection(
        &self,
        peer: PlainNodeId,
        capacity: usize,
    ) -> mpsc::Receiver<grpc_svc::NetworkMessage> {
        let (tx, rx) = mpsc::channel(capacity);
        self.inner.connections.lock().unwrap().insert(peer, Connection::new(peer, tx));
        rx
    }

    pub(crate) fn proof_remove_connection(&self, peer: PlainNodeId) {
        self.inner.connections.lock().unwrap().remove(&peer);
    }
}
