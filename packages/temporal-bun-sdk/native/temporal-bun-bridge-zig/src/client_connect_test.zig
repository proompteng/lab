const std = @import("std");
const client = @import("client.zig");
const runtime = @import("runtime.zig");
const pending = @import("pending.zig");
const errors = @import("errors.zig");

test "connectAsync returns failed handle when Temporal server is unreachable" {
    const runtime_handle = runtime.create("{}") orelse unreachable;
    defer runtime.destroy(runtime_handle);

    const config = "{\"address\":\"http://127.0.0.1:65532\",\"namespace\":\"default\"}";
    const pending_client = client.connectAsync(runtime_handle, config) orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    const status = pending.poll(@as(?*pending.PendingHandle, @ptrCast(pending_client)));
    try std.testing.expectEqual(@intFromEnum(pending.Status.failed), status);

    const message = errors.snapshot();
    try std.testing.expect(std.mem.indexOf(u8, message, "Temporal server unreachable") != null);
}
