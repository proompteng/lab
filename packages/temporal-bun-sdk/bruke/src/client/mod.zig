const common = @import("common.zig");
const connect_impl = @import("connect.zig");
const describe_impl = @import("describe_namespace.zig");
const start_impl = @import("workflows/start.zig");
const signal_with_start_impl = @import("workflows/signal_with_start.zig");
const query_impl = @import("workflows/query.zig");
const signal_impl = @import("workflows/signal.zig");
const cancel_impl = @import("workflows/cancel.zig");
const terminate_impl = @import("workflows/terminate.zig");
const update_headers_impl = @import("update_headers.zig");

pub const ClientHandle = common.ClientHandle;
pub const grpc = common.grpc;

pub const destroy = common.destroy;
pub const destroyClientFromPending = common.destroyClientFromPending;

pub const connectAsync = connect_impl.connectAsync;
pub const describeNamespaceAsync = describe_impl.describeNamespaceAsync;
pub const startWorkflow = start_impl.startWorkflow;
pub const signalWithStart = signal_with_start_impl.signalWithStart;
pub const queryWorkflow = query_impl.queryWorkflow;
pub const terminateWorkflow = terminate_impl.terminateWorkflow;
pub const signalWorkflow = signal_impl.signalWorkflow;
pub const cancelWorkflow = cancel_impl.cancelWorkflow;
pub const updateHeaders = update_headers_impl.updateHeaders;
