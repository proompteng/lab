use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use rand::RngCore;
use serde::{Serialize, de::DeserializeOwned};
use tonic::Status;

pub(super) struct Vault(Aes256Gcm);

impl Vault {
    pub(super) fn new(key: &[u8]) -> Result<Self, Status> {
        Aes256Gcm::new_from_slice(key).map(Self).map_err(|_| {
            Status::failed_precondition("provider encryption key must contain 32 bytes")
        })
    }

    pub(super) fn seal(&self, binding: &[u8], value: &impl Serialize) -> Result<Vec<u8>, Status> {
        let plaintext = serde_json::to_vec(value)
            .map_err(|_| Status::internal("encode provider credential"))?;
        let mut nonce = [0u8; 12];
        rand::rng().fill_bytes(&mut nonce);
        let ciphertext = self
            .0
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &plaintext,
                    aad: binding,
                },
            )
            .map_err(|_| Status::internal("encrypt provider credential"))?;
        Ok([nonce.as_slice(), &ciphertext].concat())
    }

    pub(super) fn open<T: DeserializeOwned>(
        &self,
        binding: &[u8],
        value: &[u8],
    ) -> Result<T, Status> {
        if value.len() < 28 || value.len() > 65_536 {
            return Err(Status::failed_precondition(
                "invalid encrypted provider credential",
            ));
        }
        let nonce: [u8; 12] = value[..12]
            .try_into()
            .map_err(|_| Status::internal("invalid credential nonce"))?;
        let plaintext = self
            .0
            .decrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: &value[12..],
                    aad: binding,
                },
            )
            .map_err(|_| Status::failed_precondition("provider credential binding changed"))?;
        serde_json::from_slice(&plaintext)
            .map_err(|_| Status::failed_precondition("invalid provider credential"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_encrypted_and_bound_to_their_account_and_profile() {
        let vault = Vault::new(&[42; 32]).unwrap();
        let first = vault
            .seal(b"workspace/account/profile", &"a disposable token")
            .unwrap();
        let second = vault
            .seal(b"workspace/account/profile", &"a disposable token")
            .unwrap();
        assert_ne!(first, second);
        assert!(
            !first
                .windows(18)
                .any(|bytes| bytes == b"a disposable token")
        );
        assert_eq!(
            vault
                .open::<String>(b"workspace/account/profile", &first)
                .unwrap(),
            "a disposable token"
        );
        assert!(
            vault
                .open::<String>(b"another workspace/account/profile", &first)
                .is_err()
        );
        assert!(
            Vault::new(&[43; 32])
                .unwrap()
                .open::<String>(b"workspace/account/profile", &first)
                .is_err()
        );
        let mut tampered = first;
        tampered[16] ^= 1;
        assert!(
            vault
                .open::<String>(b"workspace/account/profile", &tampered)
                .is_err()
        );
    }
}
