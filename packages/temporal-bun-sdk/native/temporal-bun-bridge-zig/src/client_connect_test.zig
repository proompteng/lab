const std = @import("std");
const client = @import("client.zig");
const runtime = @import("runtime.zig");
const pending = @import("pending.zig");
const errors = @import("errors.zig");

fn pollUntilFailed(handle: ?*pending.PendingHandle) bool {
    var attempts: usize = 0;
    while (attempts < 100) {
        const status = pending.poll(handle);
        if (status == @intFromEnum(pending.Status.failed)) {
            return true;
        }
        if (status == @intFromEnum(pending.Status.ready)) {
            return false;
        }
        std.Thread.sleep(1_000_000); // 1ms
        attempts += 1;
    }
    return false;
}

test "connectAsync returns failed handle when Temporal server is unreachable" {
    const runtime_handle = runtime.create("{}") orelse unreachable;
    defer runtime.destroy(runtime_handle);

    const config = "{\"address\":\"http://127.0.0.1:65532\",\"namespace\":\"default\"}";
    const pending_client = client.connectAsync(runtime_handle, config) orelse unreachable;
    defer pending.free(@as(?*pending.PendingHandle, @ptrCast(pending_client)));

    try std.testing.expect(pollUntilFailed(@as(?*pending.PendingHandle, @ptrCast(pending_client))));

    const message = errors.snapshot();
    try std.testing.expect(std.mem.indexOf(u8, message, "Temporal server unreachable") != null);
}
