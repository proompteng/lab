const common = @import("../common.zig");
const pending = @import("../../pending.zig");

const grpc = common.grpc;

pub fn cancelWorkflow(_client: ?*common.ClientHandle, _payload: []const u8) ?*pending.PendingByteArray {
    // TODO(codex, zig-wf-06): Route workflow cancellation through Temporal core client once implemented.
    _ = _client;
    _ = _payload;
    return common.createByteArrayError(grpc.unimplemented, "temporal-bun-bridge-zig: cancelWorkflow is not implemented yet");
}
