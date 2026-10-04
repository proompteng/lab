use super::*;
use std::sync::Arc;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Response, Status};

type Handler<Input, Output> = Arc<dyn Fn(Request<Input>) -> Result<Output, Status> + Send + Sync>;

#[derive(Default)]
pub(crate) struct TestService {
    pub get_info: Option<Handler<proto::Empty, proto::GuestInfo>>,
    pub open_editor: Option<Handler<proto::Empty, proto::Editor>>,
    pub list_files: Option<Handler<proto::Path, proto::FileList>>,
    pub read_file: Option<Handler<proto::Path, proto::FileContent>>,
    pub write_file: Option<Handler<proto::FileWrite, proto::FileWriteResult>>,
    pub create_directory: Option<Handler<proto::Path, proto::FileEntry>>,
    pub move_file: Option<Handler<proto::FileMove, proto::FileEntry>>,
    pub delete_file: Option<Handler<proto::FileDelete, proto::Empty>>,
    pub search_files: Option<Handler<proto::FileSearch, proto::FileSearchResult>>,
    pub create_terminal: Option<Handler<proto::TerminalCreate, proto::TerminalCreated>>,
    pub list_terminals: Option<Handler<proto::Empty, proto::TerminalList>>,
    pub terminate_terminal: Option<Handler<proto::TerminalId, proto::Empty>>,
    pub codex_call: Option<Handler<proto::CodexRequest, proto::CodexResult>>,
    pub codex_login: Option<Handler<proto::Empty, proto::CodexLoginState>>,
    pub resolve_codex_approval: Option<Handler<proto::CodexApproval, proto::Empty>>,
}

#[tonic::async_trait]
impl proto::nanoagent_service_server::NanoagentService for TestService {
    async fn get_info(
        &self,
        request: Request<proto::Empty>,
    ) -> Result<Response<proto::GuestInfo>, Status> {
        self.get_info
            .as_ref()
            .ok_or_else(|| Status::unimplemented("GetInfo"))?(request)
        .map(Response::new)
    }
    async fn open_editor(
        &self,
        request: Request<proto::Empty>,
    ) -> Result<Response<proto::Editor>, Status> {
        self.open_editor
            .as_ref()
            .ok_or_else(|| Status::unimplemented("OpenEditor"))?(request)
        .map(Response::new)
    }
    async fn list_files(
        &self,
        request: Request<proto::Path>,
    ) -> Result<Response<proto::FileList>, Status> {
        self.list_files
            .as_ref()
            .ok_or_else(|| Status::unimplemented("ListFiles"))?(request)
        .map(Response::new)
    }
    async fn read_file(
        &self,
        request: Request<proto::Path>,
    ) -> Result<Response<proto::FileContent>, Status> {
        self.read_file
            .as_ref()
            .ok_or_else(|| Status::unimplemented("ReadFile"))?(request)
        .map(Response::new)
    }
    async fn write_file(
        &self,
        request: Request<proto::FileWrite>,
    ) -> Result<Response<proto::FileWriteResult>, Status> {
        self.write_file
            .as_ref()
            .ok_or_else(|| Status::unimplemented("WriteFile"))?(request)
        .map(Response::new)
    }
    async fn create_directory(
        &self,
        request: Request<proto::Path>,
    ) -> Result<Response<proto::FileEntry>, Status> {
        self.create_directory
            .as_ref()
            .ok_or_else(|| Status::unimplemented("CreateDirectory"))?(request)
        .map(Response::new)
    }
    async fn move_file(
        &self,
        request: Request<proto::FileMove>,
    ) -> Result<Response<proto::FileEntry>, Status> {
        self.move_file
            .as_ref()
            .ok_or_else(|| Status::unimplemented("MoveFile"))?(request)
        .map(Response::new)
    }
    async fn delete_file(
        &self,
        request: Request<proto::FileDelete>,
    ) -> Result<Response<proto::Empty>, Status> {
        self.delete_file
            .as_ref()
            .ok_or_else(|| Status::unimplemented("DeleteFile"))?(request)
        .map(Response::new)
    }
    async fn search_files(
        &self,
        request: Request<proto::FileSearch>,
    ) -> Result<Response<proto::FileSearchResult>, Status> {
        self.search_files
            .as_ref()
            .ok_or_else(|| Status::unimplemented("SearchFiles"))?(request)
        .map(Response::new)
    }
    type WatchFilesStream = Pin<Box<dyn Stream<Item = Result<proto::FileEvent, Status>> + Send>>;
    async fn watch_files(
        &self,
        request: Request<proto::FileWatch>,
    ) -> Result<Response<Self::WatchFilesStream>, Status> {
        let _ = request;
        Err(Status::unimplemented("WatchFiles"))
    }
    async fn create_terminal(
        &self,
        request: Request<proto::TerminalCreate>,
    ) -> Result<Response<proto::TerminalCreated>, Status> {
        self.create_terminal
            .as_ref()
            .ok_or_else(|| Status::unimplemented("CreateTerminal"))?(request)
        .map(Response::new)
    }
    async fn list_terminals(
        &self,
        request: Request<proto::Empty>,
    ) -> Result<Response<proto::TerminalList>, Status> {
        self.list_terminals
            .as_ref()
            .ok_or_else(|| Status::unimplemented("ListTerminals"))?(request)
        .map(Response::new)
    }
    async fn terminate_terminal(
        &self,
        request: Request<proto::TerminalId>,
    ) -> Result<Response<proto::Empty>, Status> {
        self.terminate_terminal
            .as_ref()
            .ok_or_else(|| Status::unimplemented("TerminateTerminal"))?(request)
        .map(Response::new)
    }
    type AttachTerminalStream =
        Pin<Box<dyn Stream<Item = Result<proto::TerminalOutput, Status>> + Send>>;
    async fn attach_terminal(
        &self,
        request: Request<tonic::Streaming<proto::TerminalInput>>,
    ) -> Result<Response<Self::AttachTerminalStream>, Status> {
        let _ = request;
        Err(Status::unimplemented("AttachTerminal"))
    }
    async fn codex_call(
        &self,
        request: Request<proto::CodexRequest>,
    ) -> Result<Response<proto::CodexResult>, Status> {
        self.codex_call
            .as_ref()
            .ok_or_else(|| Status::unimplemented("CodexCall"))?(request)
        .map(Response::new)
    }
    async fn codex_login(
        &self,
        request: Request<proto::Empty>,
    ) -> Result<Response<proto::CodexLoginState>, Status> {
        self.codex_login
            .as_ref()
            .ok_or_else(|| Status::unimplemented("CodexLogin"))?(request)
        .map(Response::new)
    }
    async fn resolve_codex_approval(
        &self,
        request: Request<proto::CodexApproval>,
    ) -> Result<Response<proto::Empty>, Status> {
        self.resolve_codex_approval
            .as_ref()
            .ok_or_else(|| Status::unimplemented("ResolveCodexApproval"))?(request)
        .map(Response::new)
    }
    type WatchCodexEventsStream =
        Pin<Box<dyn Stream<Item = Result<proto::CodexEvent, Status>> + Send>>;
    async fn watch_codex_events(
        &self,
        request: Request<proto::CodexWatch>,
    ) -> Result<Response<Self::WatchCodexEventsStream>, Status> {
        let _ = request;
        Err(Status::unimplemented("WatchCodexEvents"))
    }
}

pub(crate) struct TestServer {
    pub guest: GuestClient,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for TestServer {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl TestServer {
    pub async fn start(service: TestService) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let rpc = RpcClient::new(&base_url, "fixture-token").unwrap();
        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(proto::nanoagent_service_server::NanoagentServiceServer::new(service))
                .serve_with_incoming(TcpListenerStream::new(listener))
                .await
                .unwrap();
        });
        Self {
            guest: GuestClient {
                rpc,
                base_url,
                token: "fixture-token".into(),
            },
            server,
        }
    }
}
