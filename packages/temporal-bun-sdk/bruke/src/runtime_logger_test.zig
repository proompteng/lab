const std = @import("std");
const runtime = @import("runtime.zig");

const testing = std.testing;

var logger_invocations: usize = 0;

fn testLoggerCallback(
    level: u32,
    target_ptr: ?[*]const u8,
    target_len: usize,
    message_ptr: ?[*]const u8,
    message_len: usize,
    timestamp_millis: u64,
    fields_ptr: ?[*]const u8,
    fields_len: usize,
) callconv(.c) void {
    _ = level;
    _ = target_ptr;
    _ = target_len;
    _ = message_ptr;
    _ = message_len;
    _ = timestamp_millis;
    _ = fields_ptr;
    _ = fields_len;
    logger_invocations += 1;
}

test "runtime.setLogger registers and forwards logs" {
    logger_invocations = 0;
    const handle = runtime.create("{}");
    try testing.expect(handle != null);
    const runtime_handle = handle.?;
    defer {
        _ = runtime.setLogger(runtime_handle, null);
        runtime.destroy(runtime_handle);
    }

    const callback_ptr = @as(?*anyopaque, @ptrCast(testLoggerCallback));
    try testing.expectEqual(@as(i32, 0), runtime.setLogger(runtime_handle, callback_ptr));

    const message = "hello";
    runtime.temporal_bun_runtime_test_emit_log(
        2,
        @as(?[*]const u8, message.ptr),
        message.len,
        @as(?[*]const u8, message.ptr),
        message.len,
        1,
        null,
        0,
    );

    try testing.expectEqual(@as(usize, 1), logger_invocations);
}

test "runtime.setLogger prevents duplicate registration" {
    const first = runtime.create("{}");
    const second = runtime.create("{}");
    try testing.expect(first != null and second != null);
    const first_handle = first.?;
    const second_handle = second.?;

    defer {
        _ = runtime.setLogger(first_handle, null);
        runtime.destroy(first_handle);
        _ = runtime.setLogger(second_handle, null);
        runtime.destroy(second_handle);
    }

    const callback_ptr = @as(?*anyopaque, @ptrCast(testLoggerCallback));
    try testing.expectEqual(@as(i32, 0), runtime.setLogger(first_handle, callback_ptr));
    try testing.expectEqual(@as(i32, -1), runtime.setLogger(second_handle, callback_ptr));
}
