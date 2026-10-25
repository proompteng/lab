fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "../../proto/proompteng/authz/v1/authz.proto";
    let descriptors = prost_build::Config::new().load_fds(&[proto], &["../../proto"])?;
    let mut rpc_paths = Vec::new();
    for file in &descriptors.file {
        for service in &file.service {
            for method in &service.method {
                rpc_paths.push(format!(
                    "/{}.{}/{}",
                    file.package(),
                    service.name(),
                    method.name()
                ));
            }
        }
    }
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR")?).join("rpc-paths.rs"),
        format!("const RPC_PATHS: &[&str] = &{rpc_paths:?};"),
    )?;
    tonic_prost_build::configure()
        .type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]")
        .field_attribute(
            ".proompteng.authz.v1.ObservationScope.connector_operations",
            "#[serde(default, skip_serializing_if = \"Vec::is_empty\")]",
        )
        .field_attribute(
            ".proompteng.authz.v1.ObservationScope.connector_runtime_epoch",
            "#[serde(default, skip_serializing_if = \"String::is_empty\")]",
        )
        .compile_fds(descriptors)?;
    println!("cargo:rerun-if-changed={proto}");
    Ok(())
}
