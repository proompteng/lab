use platform_client::{
    authz::{PlatformConnectionScope, PlatformResource},
    relay::ConnectorOperation,
};
use tonic::Status;
#[derive(Clone, Debug)]
pub struct Normalized {
    pub action: String,
    pub resources: Vec<PlatformResource>,
    pub prepared_request: Vec<u8>,
}
pub struct Output {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub upstream_status: u32,
}
pub struct Failure {
    pub status: Status,
    pub upstream_status: u32,
}
pub fn allows_operation(
    access: Option<&[PlatformConnectionScope]>,
    action: &str,
    resource: &PlatformResource,
) -> bool {
    access.is_none_or(|scopes| {
        scopes.iter().any(|scope| {
            scope.actions.iter().any(|allowed| allowed == action)
                && scope.resource.as_ref().is_some_and(|allowed| {
                    allowed.kind == resource.kind && allowed.id == resource.id
                })
        })
    })
}
#[async_trait::async_trait]
pub trait Connector: Send + Sync {
    fn id(&self) -> &str;
    fn operations(&self, access: Option<&[PlatformConnectionScope]>) -> Vec<ConnectorOperation>;
    fn normalize(&self, operation: &str, arguments: &[u8]) -> Result<Normalized, Status>;
    async fn execute(&self, request: &Normalized) -> Result<Output, Failure>;
}
