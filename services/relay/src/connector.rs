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
impl From<Status> for Failure {
    fn from(status: Status) -> Self {
        let upstream_status = status
            .metadata()
            .get("x-relay-upstream-status")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|status| *status == 401 || *status == 403)
            .unwrap_or(0);
        Self {
            status,
            upstream_status,
        }
    }
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
    fn provider(&self) -> Option<crate::credentials::Provider<'_>>;
    fn operations(&self, access: Option<&[PlatformConnectionScope]>) -> Vec<ConnectorOperation>;
    fn normalize(&self, operation: &str, arguments: &[u8]) -> Result<Normalized, Status>;
    async fn execute(&self, request: &Normalized, bearer: Option<&str>) -> Result<Output, Failure>;
}
