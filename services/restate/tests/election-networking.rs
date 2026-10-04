
#[cfg(test)]
impl<M> Networking<M>
where
    M: NetworkMessage + Clone + Send + 'static,
{
    pub(crate) fn proof_has_connection_attempt(&self, peer: PlainNodeId) -> bool {
        self.connection_attempts.contains_key(&peer)
    }

    pub(crate) fn proof_connection_attempt_count(&self) -> usize {
        self.connection_attempts.len()
    }
}
