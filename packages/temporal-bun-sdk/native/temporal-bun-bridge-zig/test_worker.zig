const std = @import("std");
const worker = @import("src/worker.zig");
const runtime = @import("src/runtime.zig");
const client = @import("src/client.zig");
const core = @import("src/core.zig");
const errors = @import("src/errors.zig");

const testing = std.testing;

test "worker creation with valid config" {
    // Mock the core API to return success
    const original_worker_new = core.api.worker_new;
    const original_worker_free = core.api.worker_free;
    defer {
        core.api.worker_new = original_worker_new;
        core.api.worker_free = original_worker_free;
    }

    core.api.worker_new = struct {
        fn mockWorkerNew(client_ptr: ?*core.Client, options_ptr: *const core.WorkerOptions) callconv(.c) core.WorkerOrFail {
            _ = client_ptr;
            _ = options_ptr;
            return core.WorkerOrFail{
                .worker = @as(?*core.Worker, @ptrFromInt(0x12345678)),
                .fail = null,
            };
        }
    }.mockWorkerNew;

    core.api.worker_free = struct {
        fn mockWorkerFree(worker_ptr: ?*core.Worker) callconv(.c) void {
            _ = worker_ptr;
        }
    }.mockWorkerFree;

    // Create fake runtime and client handles
    var rt = runtime.RuntimeHandle{
        .id = 1,
        .config = ""[0..0],
        .core_runtime = @as(?*core.RuntimeOpaque, @ptrFromInt(0x11111111)),
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    var client_handle = client.ClientHandle{
        .id = 2,
        .runtime = &rt,
        .config = ""[0..0],
        .core_client = @as(?*core.ClientOpaque, @ptrFromInt(0x22222222)),
    };

    errors.setLastError(""[0..0]);

    const config_json = "{\"namespace\":\"test-namespace\",\"taskQueue\":\"test-queue\"}";
    const worker_handle = worker.create(&rt, &client_handle, config_json);

    try testing.expect(worker_handle != null);
    try testing.expectEqual(@as(u64, 1), worker_handle.?.id);
    try testing.expectEqual(@as(?*core.WorkerOpaque, @ptrFromInt(0x12345678)), worker_handle.?.core_worker);
    try testing.expectEqualStrings("", errors.snapshot());

    // Clean up
    worker.destroy(worker_handle);
}

test "worker creation with invalid JSON config" {
    var rt = runtime.RuntimeHandle{
        .id = 1,
        .config = ""[0..0],
        .core_runtime = @as(?*core.RuntimeOpaque, @ptrFromInt(0x11111111)),
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    var client_handle = client.ClientHandle{
        .id = 2,
        .runtime = &rt,
        .config = ""[0..0],
        .core_client = @as(?*core.ClientOpaque, @ptrFromInt(0x22222222)),
    };

    errors.setLastError(""[0..0]);

    const config_json = "invalid json";
    const worker_handle = worker.create(&rt, &client_handle, config_json);

    try testing.expect(worker_handle == null);
    try testing.expect(std.mem.indexOf(u8, errors.snapshot(), "failed to parse worker config JSON") != null);
}

test "worker creation with missing namespace" {
    var rt = runtime.RuntimeHandle{
        .id = 1,
        .config = ""[0..0],
        .core_runtime = @as(?*core.RuntimeOpaque, @ptrFromInt(0x11111111)),
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    var client_handle = client.ClientHandle{
        .id = 2,
        .runtime = &rt,
        .config = ""[0..0],
        .core_client = @as(?*core.ClientOpaque, @ptrFromInt(0x22222222)),
    };

    errors.setLastError(""[0..0]);

    const config_json = "{\"taskQueue\":\"test-queue\"}";
    const worker_handle = worker.create(&rt, &client_handle, config_json);

    try testing.expect(worker_handle == null);
    try testing.expectEqualStrings("{\"code\":3,\"message\":\"temporal-bun-bridge-zig: worker config must include 'namespace' field\"}", errors.snapshot());
}

test "worker creation with missing task queue" {
    var rt = runtime.RuntimeHandle{
        .id = 1,
        .config = ""[0..0],
        .core_runtime = @as(?*core.RuntimeOpaque, @ptrFromInt(0x11111111)),
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    var client_handle = client.ClientHandle{
        .id = 2,
        .runtime = &rt,
        .config = ""[0..0],
        .core_client = @as(?*core.ClientOpaque, @ptrFromInt(0x22222222)),
    };

    errors.setLastError(""[0..0]);

    const config_json = "{\"namespace\":\"test-namespace\"}";
    const worker_handle = worker.create(&rt, &client_handle, config_json);

    try testing.expect(worker_handle == null);
    try testing.expectEqualStrings("{\"code\":3,\"message\":\"temporal-bun-bridge-zig: worker config must include 'taskQueue' field\"}", errors.snapshot());
}

test "worker creation with null runtime handle" {
    var client_handle = client.ClientHandle{
        .id = 2,
        .runtime = null,
        .config = ""[0..0],
        .core_client = @as(?*core.ClientOpaque, @ptrFromInt(0x22222222)),
    };

    errors.setLastError(""[0..0]);

    const config_json = "{\"namespace\":\"test-namespace\",\"taskQueue\":\"test-queue\"}";
    const worker_handle = worker.create(null, &client_handle, config_json);

    try testing.expect(worker_handle == null);
    try testing.expectEqualStrings("{\"code\":3,\"message\":\"temporal-bun-bridge-zig: runtime handle is required for worker creation\"}", errors.snapshot());
}

test "worker creation with null client handle" {
    var rt = runtime.RuntimeHandle{
        .id = 1,
        .config = ""[0..0],
        .core_runtime = @as(?*core.RuntimeOpaque, @ptrFromInt(0x11111111)),
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    errors.setLastError(""[0..0]);

    const config_json = "{\"namespace\":\"test-namespace\",\"taskQueue\":\"test-queue\"}";
    const worker_handle = worker.create(&rt, null, config_json);

    try testing.expect(worker_handle == null);
    try testing.expectEqualStrings("{\"code\":3,\"message\":\"temporal-bun-bridge-zig: client handle is required for worker creation\"}", errors.snapshot());
}

test "worker creation with core worker failure" {
    // Mock the core API to return failure
    const original_worker_new = core.api.worker_new;
    defer {
        core.api.worker_new = original_worker_new;
    }

    const stub_fail_message = "Worker creation failed: Invalid configuration";
    const stub_fail_buffer = core.ByteArray{
        .data = stub_fail_message.ptr,
        .size = stub_fail_message.len,
        .cap = stub_fail_message.len,
        .disable_free = true,
    };

    core.api.worker_new = struct {
        fn mockWorkerNew(client_ptr: ?*core.Client, options_ptr: *const core.WorkerOptions) callconv(.c) core.WorkerOrFail {
            _ = client_ptr;
            _ = options_ptr;
            return core.WorkerOrFail{
                .worker = null,
                .fail = &stub_fail_buffer,
            };
        }
    }.mockWorkerNew;

    var rt = runtime.RuntimeHandle{
        .id = 1,
        .config = ""[0..0],
        .core_runtime = @as(?*core.RuntimeOpaque, @ptrFromInt(0x11111111)),
        .pending_lock = .{},
        .pending_condition = .{},
        .pending_connects = 0,
        .destroying = false,
    };

    var client_handle = client.ClientHandle{
        .id = 2,
        .runtime = &rt,
        .config = ""[0..0],
        .core_client = @as(?*core.ClientOpaque, @ptrFromInt(0x22222222)),
    };

    errors.setLastError(""[0..0]);

    const config_json = "{\"namespace\":\"test-namespace\",\"taskQueue\":\"test-queue\"}";
    const worker_handle = worker.create(&rt, &client_handle, config_json);

    try testing.expect(worker_handle == null);
    try testing.expectEqualStrings("{\"code\":13,\"message\":\"Worker creation failed: Invalid configuration\"}", errors.snapshot());
}
