fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "proto/proompteng/runtime/v1/microvm.proto";
    tonic_prost_build::configure()
        .build_server(true)
        .build_client(false)
        .compile_protos(&[proto], &["proto"])?;
    println!("cargo:rerun-if-changed={proto}");

    Ok(())
}
