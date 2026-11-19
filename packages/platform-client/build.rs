fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_prost_build::configure()
        .type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]")
        .compile_protos(
            &[
                "../../proto/proompteng/authz/v1/authz.proto",
                "../../proto/proompteng/authz/v1/platform.proto",
                "../../proto/proompteng/relay/v1/relay.proto",
            ],
            &["../../proto"],
        )?;
    println!("cargo:rerun-if-changed=../../proto/proompteng/authz/v1/platform.proto");
    println!("cargo:rerun-if-changed=../../proto/proompteng/authz/v1/authz.proto");
    println!("cargo:rerun-if-changed=../../proto/proompteng/relay/v1/relay.proto");
    Ok(())
}
