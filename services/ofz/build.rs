fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "../../proto/proompteng/authz/v1/authz.proto";
    tonic_prost_build::configure()
        .type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]")
        .compile_protos(&[proto], &["../../proto"])?;
    println!("cargo:rerun-if-changed={proto}");
    Ok(())
}
