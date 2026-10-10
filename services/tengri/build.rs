fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "proto/proompteng/runtime/v1/microvm.proto";
    tonic_prost_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(&[proto], &["proto"])?;
    println!("cargo:rerun-if-changed={proto}");

    let guest_proto = "proto/proompteng/runtime/guest/v1/nanoagent.proto";
    tonic_prost_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(&[guest_proto], &["proto"])?;
    println!("cargo:rerun-if-changed={guest_proto}");

    let authz_root = std::path::PathBuf::from(
        std::env::var("OFZ_PROTO_ROOT").unwrap_or_else(|_| "../../proto".into()),
    );
    let authz_proto = authz_root.join("proompteng/authz/v1/authz.proto");
    tonic_prost_build::configure()
        .build_server(false)
        .build_client(true)
        .type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]")
        .compile_protos(&[&authz_proto], &[&authz_root])?;
    let catalog =
        std::env::var("OFZ_CATALOG_PATH").unwrap_or_else(|_| "../ofz/operations.json".into());
    std::fs::copy(
        &catalog,
        std::path::Path::new(&std::env::var("OUT_DIR")?).join("ofz-operations.json"),
    )?;
    println!("cargo:rerun-if-env-changed=OFZ_PROTO_ROOT");
    println!("cargo:rerun-if-env-changed=OFZ_CATALOG_PATH");
    println!("cargo:rerun-if-changed={}", authz_proto.display());
    println!("cargo:rerun-if-changed={catalog}");

    Ok(())
}
