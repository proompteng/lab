const client_mod = @import("client/mod.zig");

pub const ClientHandle = client_mod.ClientHandle;
pub const grpc = client_mod.grpc;

pub const destroy = client_mod.destroy;
pub const destroyClientFromPending = client_mod.destroyClientFromPending;

pub const connectAsync = client_mod.connectAsync;
pub const describeNamespaceAsync = client_mod.describeNamespaceAsync;
pub const startWorkflow = client_mod.startWorkflow;
pub const signalWithStart = client_mod.signalWithStart;
pub const queryWorkflow = client_mod.queryWorkflow;
pub const signalWorkflow = client_mod.signalWorkflow;
pub const terminateWorkflow = client_mod.terminateWorkflow;
pub const cancelWorkflow = client_mod.cancelWorkflow;
pub const updateHeaders = client_mod.updateHeaders;
