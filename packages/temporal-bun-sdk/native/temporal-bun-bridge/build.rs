use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rustc-check-cfg=cfg(temporal_client_has_allow_insecure)");
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let client_path = manifest_dir
        .join("../../vendor/sdk-core/client/src/lib.rs")
        .canonicalize()
        .unwrap_or_else(|_| manifest_dir.join("../../vendor/sdk-core/client/src/lib.rs"));

    if let Ok(contents) = fs::read_to_string(&client_path) {
        if contents.contains("allow_insecure") {
            println!("cargo:rustc-cfg=temporal_client_has_allow_insecure");
        }
    }
}
