const std = @import("std");
const testing = std.testing;
const worker = @import("worker.zig");
const errors = @import("errors.zig");
const core = @import("core.zig");
const bridge_testing = @import("testing.zig");

const empty_bytes = [_]u8{};
const empty_slice = empty_bytes[0..0];

fn resetState() void {
    bridge_testing.reset();
    errors.setLastError(empty_slice);
}

fn makeWorkerHandle(core_ptr: ?*core.WorkerOpaque) !*worker.WorkerHandle {
    const allocator = std.heap.c_allocator;
    const handle = try allocator.create(worker.WorkerHandle);
    const empty_config: []u8 = @constCast(empty_slice);
    handle.* = .{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = empty_config,
        .core_worker = core_ptr,
    };
    return handle;
}

fn destroyWorkerHandle(handle: *worker.WorkerHandle) void {
    std.heap.c_allocator.destroy(handle);
}

fn expectError(message: []const u8) !void {
    try testing.expectEqualStrings(message, errors.snapshot());
}

test "completeActivityTask rejects null handle" {
    resetState();
    const rc = worker.completeActivityTask(null, empty_slice);
    try testing.expectEqual(@as(i32, -1), rc);
    try expectError("temporal-bun-bridge-zig: completeActivityTask received null worker handle");
    try testing.expect(bridge_testing.lastSnapshot(.completed) == null);
    try testing.expect(bridge_testing.lastSnapshot(.failed) == null);
}

test "completeActivityTask requires core worker pointer" {
    resetState();
    const handle = try makeWorkerHandle(null);
    defer destroyWorkerHandle(handle);

    const payload = "{\"taskToken\":\"AQID\",\"status\":\"completed\"}";
    const rc = worker.completeActivityTask(handle, payload);
    try testing.expectEqual(@as(i32, -1), rc);
    try expectError("temporal-bun-bridge-zig: worker missing Temporal core worker handle");
    try testing.expect(bridge_testing.lastSnapshot(.completed) == null);
    try testing.expect(bridge_testing.lastSnapshot(.failed) == null);
}

test "completeActivityTask dispatches success payload" {
    resetState();
    const fake_ptr = @as(?*core.WorkerOpaque, @ptrFromInt(@as(usize, 0x4444)));
    const handle = try makeWorkerHandle(fake_ptr);
    defer destroyWorkerHandle(handle);

    const payload = "{\"taskToken\":\"AQID\",\"status\":\"completed\",\"result\":\"c3VjY2Vzcw==\"}";
    const rc = worker.completeActivityTask(handle, payload);
    try testing.expectEqual(@as(i32, 0), rc);

    if (bridge_testing.lastSnapshot(.completed)) |call| {
        try testing.expect(call.worker == fake_ptr);
        try testing.expectEqualSlices(u8, &[_]u8{ 0x01, 0x02, 0x03 }, call.task_token);
        try testing.expectEqualSlices(u8, "success", call.payload);
        try testing.expect(bridge_testing.lastSnapshot(.failed) == null);
    } else {
        try testing.expect(false);
    }

    resetState();
}

test "completeActivityTask dispatches failure payload" {
    resetState();
    const fake_ptr = @as(?*core.WorkerOpaque, @ptrFromInt(@as(usize, 0x5555)));
    const handle = try makeWorkerHandle(fake_ptr);
    defer destroyWorkerHandle(handle);

    const payload = "{\"taskToken\":\"AQID\",\"status\":\"failed\",\"failure\":\"ZmFpbHVyZQ==\"}";
    const rc = worker.completeActivityTask(handle, payload);
    try testing.expectEqual(@as(i32, 0), rc);

    if (bridge_testing.lastSnapshot(.failed)) |call| {
        try testing.expect(call.worker == fake_ptr);
        try testing.expectEqualSlices(u8, &[_]u8{ 0x01, 0x02, 0x03 }, call.task_token);
        try testing.expectEqualSlices(u8, "failure", call.payload);
        try testing.expect(bridge_testing.lastSnapshot(.completed) == null);
    } else {
        try testing.expect(false);
    }

    resetState();
}

test "completeActivityTask rejects failed payload without failure bytes" {
    resetState();
    const fake_ptr = @as(?*core.WorkerOpaque, @ptrFromInt(@as(usize, 0x6666)));
    const handle = try makeWorkerHandle(fake_ptr);
    defer destroyWorkerHandle(handle);

    const payload = "{\"taskToken\":\"AQID\",\"status\":\"failed\"}";
    const rc = worker.completeActivityTask(handle, payload);
    try testing.expectEqual(@as(i32, -1), rc);
    try expectError("temporal-bun-bridge-zig: failure payload missing for failed activity completion");
    try testing.expect(bridge_testing.lastSnapshot(.completed) == null);
    try testing.expect(bridge_testing.lastSnapshot(.failed) == null);
    resetState();
}
