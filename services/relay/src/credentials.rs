use tokio::io::AsyncReadExt;
use tonic::Status;

pub(crate) async fn read_file(path: &str) -> Result<String, Status> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| Status::unavailable("provider credential unavailable"))?;
    let mut value = String::new();
    file.take(16_385)
        .read_to_string(&mut value)
        .await
        .map_err(|_| Status::unavailable("invalid provider credential"))?;
    if value.len() > 16_384 || value.contains('\0') || value.trim_end().is_empty() {
        return Err(Status::unavailable("invalid provider credential"));
    }
    Ok(value.trim_end().into())
}
