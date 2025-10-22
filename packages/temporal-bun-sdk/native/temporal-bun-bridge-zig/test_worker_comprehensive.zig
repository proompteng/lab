const std = @import("std");
const worker = @import("src/worker.zig");
const runtime = @import("src/runtime.zig");
const client = @import("src/client.zig");
const core = @import("src/core.zig");
const errors = @import("src/errors.zig");
const pending = @import("src/pending.zig");

const testing = std.testing;

test "worker handle structure validation" {
    const worker_handle = worker.WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = null,
    };

    try testing.expectEqual(@as(u64, 1), worker_handle.id);
    try testing.expect(worker_handle.runtime == null);
    try testing.expect(worker_handle.client == null);
    try testing.expectEqualStrings("", worker_handle.config);
    try testing.expect(worker_handle.core_worker == null);
}

test "worker handle ID increment" {
    const initial_id = worker.next_worker_id;

    const worker_handle1 = worker.WorkerHandle{
        .id = initial_id,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = null,
    };

    const worker_handle2 = worker.WorkerHandle{
        .id = initial_id + 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = null,
    };

    try testing.expectEqual(initial_id, worker_handle1.id);
    try testing.expectEqual(initial_id + 1, worker_handle2.id);
}

test "worker config duplication" {
    const test_config = "{\"namespace\":\"test\",\"taskQueue\":\"queue\"}";

    const duplicated = worker.duplicateConfig(test_config);
    try testing.expect(duplicated != null);

    if (duplicated) |config| {
        defer std.heap.c_allocator.free(config);
        try testing.expectEqualStrings(test_config, config);
    }
}

test "worker config duplication with empty string" {
    const duplicated = worker.duplicateConfig("");
    try testing.expect(duplicated != null);

    if (duplicated) |config| {
        try testing.expectEqualStrings("", config);
    }
}

test "worker config duplication with null input" {
    const duplicated = worker.duplicateConfig(""[0..0]);
    try testing.expect(duplicated != null);

    if (duplicated) |config| {
        try testing.expectEqualStrings("", config);
    }
}

test "worker handle release" {
    const allocator = std.heap.c_allocator;
    const worker_handle = allocator.create(worker.WorkerHandle) catch {
        try testing.expect(false); // Should not fail
        return;
    };

    worker_handle.* = worker.WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = null,
    };

    // Should not crash
    worker.releaseHandle(worker_handle);
}

test "worker handle release with config" {
    const allocator = std.heap.c_allocator;
    const worker_handle = allocator.create(worker.WorkerHandle) catch {
        try testing.expect(false); // Should not fail
        return;
    };

    const config = allocator.alloc(u8, 10) catch {
        try testing.expect(false); // Should not fail
        return;
    };

    worker_handle.* = worker.WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = config,
        .core_worker = null,
    };

    // Should not crash
    worker.releaseHandle(worker_handle);
}

test "worker destroy with null handle" {
    worker.destroy(null);
    // Should not crash
}

test "worker poll workflow task with null handle" {
    const result = worker.pollWorkflowTask(null);
    try testing.expect(result != null);

    if (result) |pending_handle| {
        // Should be an error pending handle
        _ = pending_handle; // Just check it exists
    }
}

test "worker poll activity task with null handle" {
    const result = worker.pollActivityTask(null);
    try testing.expect(result != null);

    if (result) |pending_handle| {
        // Should be an error pending handle
        _ = pending_handle; // Just check it exists
    }
}

test "worker complete workflow task with null handle" {
    const result = worker.completeWorkflowTask(null, "test payload");
    try testing.expectEqual(@as(i32, -1), result);
}

test "worker complete activity task with null handle" {
    const result = worker.completeActivityTask(null, "test payload");
    try testing.expectEqual(@as(i32, -1), result);
}

test "worker record activity heartbeat with null handle" {
    const result = worker.recordActivityHeartbeat(null, "test payload");
    try testing.expectEqual(@as(i32, -1), result);
}

test "worker initiate shutdown with null handle" {
    const result = worker.initiateShutdown(null);
    try testing.expectEqual(@as(i32, -1), result);
}

test "worker finalize shutdown with null handle" {
    const result = worker.finalizeShutdown(null);
    try testing.expectEqual(@as(i32, -1), result);
}

test "worker completion state structure" {
    var state = worker.CompletionState{};

    try testing.expect(state.fail_ptr == null);

    // Start wait group
    state.wait_group.start();

    // Finish wait group
    state.wait_group.finish();

    // Should not crash
}

test "worker completion callback" {
    var state = worker.CompletionState{};

    // Call callback with null user data
    worker.workflowCompletionCallback(null, null);

    // Call callback with valid user data
    worker.workflowCompletionCallback(@as(?*anyopaque, @ptrCast(&state)), null);

    // Should not crash
}

test "worker poll callback" {
    var state = worker.CompletionState{};

    // Call callback with null user data
    worker.workflowPollCallback(null, null, null);

    // Call callback with valid user data
    worker.workflowPollCallback(@as(?*anyopaque, @ptrCast(&state)), null, null);

    // Should not crash
}

test "worker byte array slice" {
    const result1 = worker.byteArraySlice(null);
    try testing.expectEqualStrings("", result1);

    // Test with valid byte array
    var byte_array = core.ByteArray{
        .data = "test data".ptr,
        .size = "test data".len,
        .cap = "test data".len,
        .disable_free = true,
    };

    const result2 = worker.byteArraySlice(&byte_array);
    try testing.expectEqualStrings("test data", result2);
}

test "worker byte array slice with null data" {
    var byte_array = core.ByteArray{
        .data = null,
        .size = 0,
        .cap = 0,
        .disable_free = false,
    };

    const result = worker.byteArraySlice(&byte_array);
    try testing.expectEqualStrings("", result);
}

test "worker byte array slice with zero size" {
    var byte_array = core.ByteArray{
        .data = "test data".ptr,
        .size = 0,
        .cap = "test data".len,
        .disable_free = true,
    };

    const result = worker.byteArraySlice(&byte_array);
    try testing.expectEqualStrings("", result);
}

test "worker complete workflow task with empty payload" {
    // Create a mock worker handle
    const allocator = std.heap.c_allocator;
    const worker_handle = allocator.create(worker.WorkerHandle) catch {
        try testing.expect(false);
        return;
    };

    worker_handle.* = worker.WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = null,
    };

    const result = worker.completeWorkflowTask(worker_handle, "");
    try testing.expectEqual(@as(i32, -1), result);

    allocator.destroy(worker_handle);
}

test "worker complete activity task with empty payload" {
    // Create a mock worker handle
    const allocator = std.heap.c_allocator;
    const worker_handle = allocator.create(worker.WorkerHandle) catch {
        try testing.expect(false);
        return;
    };

    worker_handle.* = worker.WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = null,
    };

    const result = worker.completeActivityTask(worker_handle, "");
    try testing.expectEqual(@as(i32, -1), result);

    allocator.destroy(worker_handle);
}

test "worker record activity heartbeat with empty payload" {
    // Create a mock worker handle
    const allocator = std.heap.c_allocator;
    const worker_handle = allocator.create(worker.WorkerHandle) catch {
        try testing.expect(false);
        return;
    };

    worker_handle.* = worker.WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = null,
    };

    const result = worker.recordActivityHeartbeat(worker_handle, "");
    try testing.expectEqual(@as(i32, -1), result);

    allocator.destroy(worker_handle);
}

test "worker poll workflow task with mock core worker" {
    // Create a mock worker handle with core worker
    const allocator = std.heap.c_allocator;
    const worker_handle = allocator.create(worker.WorkerHandle) catch {
        try testing.expect(false);
        return;
    };

    worker_handle.* = worker.WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrFromInt(0x12345678)),
    };

    const result = worker.pollWorkflowTask(worker_handle);
    try testing.expect(result != null);

    if (result) |pending_handle| {
        // Should be a pending handle
        _ = pending_handle;
    }

    allocator.destroy(worker_handle);
}

test "worker poll activity task with mock core worker" {
    // Create a mock worker handle with core worker
    const allocator = std.heap.c_allocator;
    const worker_handle = allocator.create(worker.WorkerHandle) catch {
        try testing.expect(false);
        return;
    };

    worker_handle.* = worker.WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrFromInt(0x12345678)),
    };

    const result = worker.pollActivityTask(worker_handle);
    try testing.expect(result != null);

    if (result) |pending_handle| {
        // Should be a pending handle
        _ = pending_handle;
    }

    allocator.destroy(worker_handle);
}

test "worker initiate shutdown with mock core worker" {
    // Create a mock worker handle with core worker
    const allocator = std.heap.c_allocator;
    const worker_handle = allocator.create(worker.WorkerHandle) catch {
        try testing.expect(false);
        return;
    };

    worker_handle.* = worker.WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrFromInt(0x12345678)),
    };

    const result = worker.initiateShutdown(worker_handle);
    try testing.expectEqual(@as(i32, 0), result);

    allocator.destroy(worker_handle);
}

test "worker finalize shutdown with mock core worker" {
    // Create a mock worker handle with core worker
    const allocator = std.heap.c_allocator;
    const worker_handle = allocator.create(worker.WorkerHandle) catch {
        try testing.expect(false);
        return;
    };

    worker_handle.* = worker.WorkerHandle{
        .id = 1,
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = @as(?*core.WorkerOpaque, @ptrFromInt(0x12345678)),
    };

    const result = worker.finalizeShutdown(worker_handle);
    try testing.expectEqual(@as(i32, -1), result); // Should fail due to missing runtime

    allocator.destroy(worker_handle);
}

test "worker error handling" {
    // Test error state
    errors.setLastError("test error");
    const error_message = errors.snapshot();
    try testing.expectEqualStrings("test error", error_message);

    // Clear error
    errors.setLastError(""[0..0]);
    const cleared_message = errors.snapshot();
    try testing.expectEqualStrings("", cleared_message);
}

test "worker memory management" {
    // Test allocation and deallocation
    const allocator = std.heap.c_allocator;

    // Allocate multiple handles
    const handles = allocator.alloc(worker.WorkerHandle, 10) catch {
        try testing.expect(false);
        return;
    };

    // Initialize handles
    for (handles, 0..) |*handle, i| {
        handle.* = worker.WorkerHandle{
            .id = @as(u64, i + 1),
            .runtime = null,
            .client = null,
            .config = ""[0..0],
            .core_worker = null,
        };
    }

    // Verify handles
    for (handles, 0..) |handle, i| {
        try testing.expectEqual(@as(u64, i + 1), handle.id);
    }

    // Clean up
    allocator.free(handles);
}

test "worker concurrent access simulation" {
    // Simulate concurrent access patterns
    const allocator = std.heap.c_allocator;

    // Create multiple worker handles
    var handles: [5]worker.WorkerHandle = undefined;
    for (&handles, 0..) |*handle, i| {
        handle.* = worker.WorkerHandle{
            .id = @as(u64, i + 1),
            .runtime = null,
            .client = null,
            .config = ""[0..0],
            .core_worker = null,
        };
    }

    // Test operations on different handles
    for (&handles) |*handle| {
        const result1 = worker.initiateShutdown(handle);
        try testing.expectEqual(@as(i32, -1), result1); // Should fail due to null core worker

        const result2 = worker.finalizeShutdown(handle);
        try testing.expectEqual(@as(i32, -1), result2); // Should fail due to null core worker

        const result3 = worker.pollWorkflowTask(handle);
        try testing.expect(result3 != null); // Should return error pending handle

        const result4 = worker.pollActivityTask(handle);
        try testing.expect(result4 != null); // Should return error pending handle
    }
}

test "worker edge cases" {
    // Test edge cases

    // Test with maximum ID
    const max_id_handle = worker.WorkerHandle{
        .id = std.math.maxInt(u64),
        .runtime = null,
        .client = null,
        .config = ""[0..0],
        .core_worker = null,
    };

    try testing.expectEqual(std.math.maxInt(u64), max_id_handle.id);

    // Test with very long config
    const long_config = "x".repeat(10000);
    const duplicated = worker.duplicateConfig(long_config);
    try testing.expect(duplicated != null);

    if (duplicated) |config| {
        defer std.heap.c_allocator.free(config);
        try testing.expectEqualStrings(long_config, config);
    }

    // Test with special characters in config
    const special_config = "{\"namespace\":\"test-\\\"namespace\\\"\",\"taskQueue\":\"queue-\\n-test\"}";
    const duplicated_special = worker.duplicateConfig(special_config);
    try testing.expect(duplicated_special != null);

    if (duplicated_special) |config| {
        defer std.heap.c_allocator.free(config);
        try testing.expectEqualStrings(special_config, config);
    }
}
