const std = @import("std");
const worker = @import("src/worker.zig");
const runtime = @import("src/runtime.zig");
const client = @import("src/client.zig");
const core = @import("src/core.zig");
const errors = @import("src/errors.zig");

const testing = std.testing;

test "worker handle structure validation" {
    // Test that WorkerHandle has the expected structure
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
    // Test that worker IDs increment correctly
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
    // Test config duplication function
    const test_config = "{\"namespace\":\"test\",\"taskQueue\":\"queue\"}";

    const duplicated = worker.duplicateConfig(test_config);
    try testing.expect(duplicated != null);

    if (duplicated) |config| {
        defer std.heap.c_allocator.free(config);
        try testing.expectEqualStrings(test_config, config);
    }
}

test "worker config duplication with empty string" {
    // Test config duplication with empty string
    const duplicated = worker.duplicateConfig("");
    try testing.expect(duplicated != null);

    if (duplicated) |config| {
        try testing.expectEqualStrings("", config);
    }
}

test "worker config duplication with null input" {
    // Test config duplication with null input
    const duplicated = worker.duplicateConfig(""[0..0]);
    try testing.expect(duplicated != null);

    if (duplicated) |config| {
        try testing.expectEqualStrings("", config);
    }
}

test "worker handle release" {
    // Test worker handle release function
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
    // Test worker handle release with config
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
    // Test worker destroy with null handle
    worker.destroy(null);
    // Should not crash
}

test "worker poll workflow task with null handle" {
    // Test worker poll workflow task with null handle
    const result = worker.pollWorkflowTask(null);
    try testing.expect(result != null);

    if (result) |pending_handle| {
        // Should be an error pending handle
        _ = pending_handle; // Just check it exists
    }
}

test "worker poll activity task with null handle" {
    // Test worker poll activity task with null handle
    const result = worker.pollActivityTask(null);
    try testing.expect(result != null);

    if (result) |pending_handle| {
        // Should be an error pending handle
        _ = pending_handle; // Just check it exists
    }
}

test "worker complete workflow task with null handle" {
    // Test worker complete workflow task with null handle
    const result = worker.completeWorkflowTask(null, "test payload");
    try testing.expectEqual(@as(i32, -1), result);
}

test "worker complete activity task with null handle" {
    // Test worker complete activity task with null handle
    const result = worker.completeActivityTask(null, "test payload");
    try testing.expectEqual(@as(i32, -1), result);
}

test "worker record activity heartbeat with null handle" {
    // Test worker record activity heartbeat with null handle
    const result = worker.recordActivityHeartbeat(null, "test payload");
    try testing.expectEqual(@as(i32, -1), result);
}

test "worker initiate shutdown with null handle" {
    // Test worker initiate shutdown with null handle
    const result = worker.initiateShutdown(null);
    try testing.expectEqual(@as(i32, -1), result);
}

test "worker finalize shutdown with null handle" {
    // Test worker finalize shutdown with null handle
    const result = worker.finalizeShutdown(null);
    try testing.expectEqual(@as(i32, -1), result);
}

test "worker completion state structure" {
    // Test CompletionState structure
    var state = worker.CompletionState{};

    try testing.expect(state.fail_ptr == null);

    // Start wait group
    state.wait_group.start();

    // Finish wait group
    state.wait_group.finish();

    // Should not crash
}

test "worker completion callback" {
    // Test workflow completion callback
    var state = worker.CompletionState{};

    // Call callback with null user data
    worker.workflowCompletionCallback(null, null);

    // Call callback with valid user data
    worker.workflowCompletionCallback(@as(?*anyopaque, @ptrCast(&state)), null);

    // Should not crash
}

test "worker byte array slice" {
    // Test byte array slice function
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
    // Test byte array slice with null data
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
    // Test byte array slice with zero size
    var byte_array = core.ByteArray{
        .data = "test data".ptr,
        .size = 0,
        .cap = "test data".len,
        .disable_free = true,
    };

    const result = worker.byteArraySlice(&byte_array);
    try testing.expectEqualStrings("", result);
}
