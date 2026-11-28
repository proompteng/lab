use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use tengri::guest_authorization::*;

#[test]
fn every_http_preview_verb_requires_privileged_application_access() {
    for method in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
        assert_eq!(
            request_action(&format!("HTTP {method}")),
            Some(GuestAction::PreviewAccess)
        );
    }
    for method in ["CONNECT", "TRACE", "PRI", "get", "GET /other"] {
        assert_eq!(request_action(&format!("HTTP {method}")), None);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    seed_hex: String,
    public_key: String,
    now_unix_ms: u64,
    body: String,
    payload: String,
    proof: GuestProof,
    invalid: Vec<InvalidVector>,
    valid: Vec<ValidVector>,
}
#[derive(Deserialize)]
struct ValidVector {
    name: String,
    body: String,
    payload: String,
    proof: GuestProof,
}
#[derive(Deserialize)]
struct InvalidVector {
    name: String,
    proof: GuestProof,
}

fn fixture() -> Vector {
    serde_json::from_str(include_str!("../fixtures/ofz-guest-request-v4.json")).unwrap()
}

fn seed(vector: &Vector) -> Vec<u8> {
    vector
        .seed_hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn binding<'a>(c: &'a GuestContext, body: &'a [u8]) -> GuestBinding<'a> {
    GuestBinding {
        workspace_uid: &c.workspace_uid,
        runtime_epoch: &c.runtime_epoch,
        slot_epoch: c.slot_epoch,
        pod_uid: &c.pod_uid,
        leader_owner: &c.leader_owner,
        leader_generation: c.leader_generation,
        recovery_generation: c.recovery_generation,
        action: c.action,
        method: &c.method,
        target: &c.target,
        body,
    }
}

#[test]
fn node_ed25519_vector_matches_rust_signing_and_verification() {
    let vector = fixture();
    let signer = GuestSigner::from_seed(&seed(&vector)).unwrap();
    assert_eq!(
        URL_SAFE_NO_PAD.encode(signer.public_key()),
        vector.public_key
    );
    let verifier = GuestVerifier::from_bytes(signer.public_key()).unwrap();
    let context = verifier.verify(&vector.proof, vector.now_unix_ms).unwrap();
    assert_eq!(serde_json::to_string(&context).unwrap(), vector.payload);
    let signed = signer.sign(&context, vector.now_unix_ms).unwrap();
    assert_eq!(signed.context, vector.proof.context);
    assert_eq!(signed.signature, vector.proof.signature);
    verifier
        .verify_for(
            &signed,
            &binding(&context, vector.body.as_bytes()),
            vector.now_unix_ms,
        )
        .unwrap();
}

#[test]
fn signed_invalid_contract_vectors_are_denied() {
    let vector = fixture();
    let verifier =
        GuestVerifier::from_bytes(&URL_SAFE_NO_PAD.decode(&vector.public_key).unwrap()).unwrap();
    for case in vector.invalid {
        assert!(
            verifier.verify(&case.proof, vector.now_unix_ms).is_err(),
            "accepted {}",
            case.name
        );
    }
}

#[test]
fn all_actor_kinds_and_scopes_round_trip_across_languages() {
    let vector = fixture();
    let signer = GuestSigner::from_seed(&seed(&vector)).unwrap();
    let verifier = GuestVerifier::from_bytes(signer.public_key()).unwrap();
    for case in vector.valid {
        let c = verifier
            .verify(&case.proof, vector.now_unix_ms)
            .unwrap_or_else(|e| panic!("{}: {e}", case.name));
        assert_eq!(serde_json::to_string(&c).unwrap(), case.payload);
        assert_eq!(
            signer.sign(&c, vector.now_unix_ms).unwrap().signature,
            case.proof.signature
        );
        verifier
            .verify_for(
                &case.proof,
                &binding(&c, case.body.as_bytes()),
                vector.now_unix_ms,
            )
            .unwrap();
        if c.observation.is_some() {
            assert!(case.payload.len() <= MAX_CONTEXT_BYTES);
            let mut retargeted = binding(&c, case.body.as_bytes());
            retargeted.target = "/workspace/another-authorized-root/report.txt";
            assert!(
                verifier
                    .verify_for(&case.proof, &retargeted, vector.now_unix_ms)
                    .is_err(),
                "a request budget must not authorize another target: {}",
                case.name
            );
        }
    }
}

#[test]
fn all_runtime_authority_and_request_bindings_are_exact() {
    let vector = fixture();
    let verifier =
        GuestVerifier::from_bytes(&URL_SAFE_NO_PAD.decode(&vector.public_key).unwrap()).unwrap();
    let context = verifier.verify(&vector.proof, vector.now_unix_ms).unwrap();
    let other = "88888888-8888-4888-8888-888888888888";
    for field in [
        "workspace",
        "runtime",
        "slot",
        "pod",
        "leader",
        "generation",
        "recovery",
        "action",
        "method",
        "target",
        "body",
    ] {
        let mut expected = binding(&context, vector.body.as_bytes());
        match field {
            "workspace" => expected.workspace_uid = other,
            "runtime" => expected.runtime_epoch = other,
            "slot" => expected.slot_epoch += 1,
            "pod" => expected.pod_uid = other,
            "leader" => expected.leader_owner = other,
            "generation" => expected.leader_generation += 1,
            "recovery" => expected.recovery_generation += 1,
            "action" => expected.action = GuestAction::FilesObserve,
            "method" => expected.method = "/proompteng.runtime.guest.v1.NanoagentService/ReadFile",
            "target" => expected.target = "/workspace/other.txt",
            "body" => expected.body = b"changed request bytes",
            _ => unreachable!(),
        }
        assert!(
            verifier
                .verify_for(&vector.proof, &expected, vector.now_unix_ms)
                .is_err(),
            "accepted changed {field}"
        );
    }
}

#[test]
fn proof_expiry_signature_key_and_encoding_are_checked() {
    let vector = fixture();
    let signer = GuestSigner::from_seed(&seed(&vector)).unwrap();
    let verifier = GuestVerifier::from_bytes(signer.public_key()).unwrap();
    assert!(
        verifier
            .verify(&vector.proof, vector.now_unix_ms + MAX_ADMISSION_MS)
            .is_err()
    );
    assert!(
        GuestVerifier::from_bytes(&[0; 32])
            .unwrap()
            .verify(&vector.proof, vector.now_unix_ms)
            .is_err()
    );
    for field in ["context", "signature"] {
        let mut proof = vector.proof.clone();
        let value = if field == "context" {
            &mut proof.context
        } else {
            &mut proof.signature
        };
        value.replace_range(..1, if value.starts_with('A') { "B" } else { "A" });
        assert!(verifier.verify(&proof, vector.now_unix_ms).is_err());
        let mut proof = vector.proof.clone();
        if field == "context" {
            proof.context.push('=');
        } else {
            proof.signature.push('=');
        }
        assert!(verifier.verify(&proof, vector.now_unix_ms).is_err());
    }
}

#[test]
fn missing_and_duplicate_proof_headers_are_denied() {
    let vector = fixture();
    let mut headers = http::HeaderMap::new();
    assert!(GuestProof::from_headers(&headers).is_err());
    headers.insert(CONTEXT_HEADER, vector.proof.context.parse().unwrap());
    assert!(GuestProof::from_headers(&headers).is_err());
    headers.insert(SIGNATURE_HEADER, vector.proof.signature.parse().unwrap());
    GuestProof::from_headers(&headers).unwrap();
    for field in [CONTEXT_HEADER, SIGNATURE_HEADER] {
        let mut repeated = headers.clone();
        repeated.append(field, headers[field].clone());
        assert!(GuestProof::from_headers(&repeated).is_err());
    }
}

#[test]
fn every_declared_guest_rpc_has_an_explicit_action() {
    let catalog: serde_json::Value = serde_json::from_slice(include_bytes!(concat!(
        env!("OUT_DIR"),
        "/ofz-operations.json"
    )))
    .unwrap();
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/ofz-guest-request-v4.json")).unwrap();
    let mut catalog_count = 0;
    for entry in catalog
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["surface"] == "guest")
    {
        let operation = entry["operation"].as_str().unwrap();
        let expected: GuestAction = serde_json::from_value(entry["action"].clone()).unwrap();
        assert_eq!(
            rpc_action(&format!(
                "/proompteng.runtime.guest.v1.NanoagentService/{operation}"
            )),
            Some(expected)
        );
        assert_eq!(vector["rpcActions"][operation], entry["action"]);
        catalog_count += 1;
    }
    let proto = include_str!("../proto/proompteng/runtime/guest/v1/nanoagent.proto");
    let mut methods = 0;
    for declaration in proto
        .lines()
        .filter_map(|line| line.trim().strip_prefix("rpc "))
    {
        let operation = declaration.split('(').next().unwrap();
        assert!(
            rpc_action(&format!(
                "/proompteng.runtime.guest.v1.NanoagentService/{operation}"
            ))
            .is_some(),
            "unclassified guest RPC {operation}"
        );
        methods += 1;
    }
    assert_eq!(methods, 19);
    assert_eq!(catalog_count, methods);
    assert_eq!(vector["rpcActions"].as_object().unwrap().len(), methods);
    assert!(rpc_action("/proompteng.runtime.guest.v1.NanoagentService/Unknown").is_none());
}

#[test]
fn workload_proofs_cannot_expand_beyond_exact_maintenance_operations() {
    let vector = fixture();
    let signer = GuestSigner::from_seed(&seed(&vector)).unwrap();
    let verifier = GuestVerifier::from_bytes(signer.public_key()).unwrap();
    let mut context = verifier.verify(&vector.proof, vector.now_unix_ms).unwrap();
    context.actor = GuestActor::Workload {
        subject: "spiffe://proompteng.ai/ns/tengri/sa/tengri".into(),
        purpose: MaintenancePurpose::Probe,
    };
    context.action = GuestAction::WorkspaceMetadataRead;
    context.method = "/proompteng.runtime.guest.v1.NanoagentService/GetInfo".into();
    context.target.clear();
    signer.sign(&context, vector.now_unix_ms).unwrap();
    context.method = "/proompteng.runtime.guest.v1.NanoagentService/ReadFile".into();
    assert!(signer.sign(&context, vector.now_unix_ms).is_err());
    context.actor = GuestActor::Workload {
        subject: "spiffe://proompteng.ai/ns/tengri/sa/tengri".into(),
        purpose: MaintenancePurpose::TerminalCleanup,
    };
    context.action = GuestAction::TerminalControl;
    context.method = "/proompteng.runtime.guest.v1.NanoagentService/TerminateTerminal".into();
    assert!(signer.sign(&context, vector.now_unix_ms).is_err());
    context.target = "terminal-42".into();
    signer.sign(&context, vector.now_unix_ms).unwrap();
    context.method = "/proompteng.runtime.guest.v1.NanoagentService/CreateTerminal".into();
    assert!(signer.sign(&context, vector.now_unix_ms).is_err());
}

#[test]
fn recovery_generation_file_requires_a_canonical_positive_bounded_value() {
    let directory =
        std::env::temp_dir().join(format!("ofz-guest-generation-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    let path = directory.join("generation");
    assert!(recovery_generation_from_file(&path).is_err());
    assert!(recovery_generation_from_file(&directory).is_err());
    for (value, expected) in [
        ("1", 1),
        ("1\n", 1),
        ("9223372036854775807\n", i64::MAX as u64),
    ] {
        fs::write(&path, value).unwrap();
        assert_eq!(recovery_generation_from_file(&path).unwrap(), expected);
    }
    for value in [
        "",
        "0",
        "01",
        "+1",
        "-1",
        "1 ",
        "1\r\n",
        "1\n\n",
        "9223372036854775808",
        "18446744073709551616",
        "123456789012345678901234567890",
    ] {
        fs::write(&path, value).unwrap();
        assert!(
            recovery_generation_from_file(&path).is_err(),
            "accepted {value:?}"
        );
    }
    fs::write(&path, "2").unwrap();
    for mode in [0o460, 0o402] {
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        assert!(recovery_generation_from_file(&path).is_err());
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
    let link = directory.join("projected-generation");
    symlink(&path, &link).unwrap();
    assert_eq!(recovery_generation_from_file(&link).unwrap(), 2);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn key_files_support_secret_projection_and_reject_wrong_lengths_and_permissions() {
    let directory = std::env::temp_dir().join(format!("ofz-guest-keys-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    let path = directory.join("seed");
    fs::write(&path, [7; 32]).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let signer = GuestSigner::from_file(&path).unwrap();
    let public = directory.join("public");
    fs::write(&public, signer.public_key()).unwrap();
    fs::set_permissions(&public, fs::Permissions::from_mode(0o444)).unwrap();
    GuestVerifier::from_file(&public).unwrap();
    let link = directory.join("link");
    symlink(&path, &link).unwrap();
    GuestSigner::from_file(&link).unwrap();
    GuestVerifier::from_file(&link).unwrap();
    for mode in [0o644, 0o460, 0o402] {
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        assert!(GuestSigner::from_file(&path).is_err());
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    for size in [0, 31, 33, 8192] {
        fs::write(&path, vec![0; size]).unwrap();
        assert!(GuestSigner::from_file(&path).is_err());
        assert!(GuestVerifier::from_file(&path).is_err());
    }
    fs::remove_dir_all(directory).unwrap();
}
