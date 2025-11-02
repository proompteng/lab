const std = @import("std");
const worker = @import("worker.zig");
const runtime = @import("runtime.zig");
const core = @import("core.zig");
const byte_array = @import("byte_array.zig");

pub const PollMode = enum(u8) {
    success = 0,
    failure = 1,
    shutdown = 2,
};

var fake_runtime_storage: usize = 0;
var fake_worker_storage: usize = 0;

const default_success_payload = "stub-activation";
const default_failure_message = "stub-poll-failure";

var poll_success_payload: []const u8 = default_success_payload;
var poll_success_payload_owned: bool = false;

var test_runtime_handle = runtime.RuntimeHandle{
    .id = 900,
    .config = ""[0..0],
    .core_runtime = @as(?*core.RuntimeOpaque, @ptrCast(&fake_runtime_storage)),
    .pending_lock = .{},
    .pending_condition = .{},
    .pending_connects = 0,
    .destroying = false,
};

var test_worker_handle = worker.WorkerHandle{
    .id = 901,
    .runtime = &test_runtime_handle,
    .client = null,
    .config = ""[0..0],
    .namespace = ""[0..0],
    .task_queue = ""[0..0],
    .identity = ""[0..0],
    .build_id = ""[0..0],
    .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&fake_worker_storage)),
    .poll_lock = .{},
    .poll_condition = .{},
    .pending_polls = 0,
    .destroy_state = .idle,
    .buffers_released = false,
};

var success_buffer = core.ByteArray{
    .data = default_success_payload.ptr,
    .size = default_success_payload.len,
    .cap = default_success_payload.len,
    .disable_free = true,
};

var failure_buffer = core.ByteArray{
    .data = default_failure_message.ptr,
    .size = default_failure_message.len,
    .cap = default_failure_message.len,
    .disable_free = true,
};

var poll_mode: PollMode = .success;

var completion_record: ?*byte_array.ByteArray = null;
var completion_record_count: usize = 0;

fn resetPollState() void {
    if (poll_success_payload_owned and poll_success_payload.len > 0) {
        var allocator = std.heap.c_allocator;
        allocator.free(@constCast(poll_success_payload.ptr)[0..poll_success_payload.len]);
    }

    poll_success_payload_owned = false;
    poll_success_payload = default_success_payload;
    success_buffer = .{
        .data = default_success_payload.ptr,
        .size = default_success_payload.len,
        .cap = default_success_payload.len,
        .disable_free = true,
    };
}

fn applyPollSuccessPayload(bytes: []const u8) bool {
    if (poll_success_payload_owned and poll_success_payload.len > 0) {
        var allocator = std.heap.c_allocator;
        allocator.free(@constCast(poll_success_payload.ptr)[0..poll_success_payload.len]);
        poll_success_payload_owned = false;
    }

    if (bytes.len == 0) {
        poll_success_payload = ""[0..0];
        success_buffer = .{
            .data = null,
            .size = 0,
            .cap = 0,
            .disable_free = false,
        };
        return true;
    }

    var allocator = std.heap.c_allocator;
    const copy = allocator.alloc(u8, bytes.len) catch {
        poll_success_payload = ""[0..0];
        success_buffer = .{
            .data = null,
            .size = 0,
            .cap = 0,
            .disable_free = false,
        };
        return false;
    };

    @memcpy(copy, bytes);
    poll_success_payload_owned = true;
    poll_success_payload = copy;
    success_buffer = .{
        .data = copy.ptr,
        .size = bytes.len,
        .cap = bytes.len,
        .disable_free = false,
    };
    return true;
}

fn resetCompletionState() void {
    if (completion_record) |array_ptr| {
        byte_array.free(array_ptr);
        completion_record = null;
    }
    completion_record_count = 0;
}

fn recordCompletionPayload(ref: core.ByteArrayRef) void {
    if (completion_record) |array_ptr| {
        byte_array.free(array_ptr);
        completion_record = null;
    }

    if (ref.data == null or ref.size == 0) {
        completion_record = byte_array.allocateFromSlice(""[0..0]);
        return;
    }

    const data_ptr = @as([*]const u8, @ptrCast(ref.data));
    const slice = data_ptr[0..ref.size];
    completion_record = byte_array.allocateFromSlice(slice);
}

fn testPollCallback(
    _worker: ?*core.WorkerOpaque,
    user_data: ?*anyopaque,
    callback: core.WorkerPollCallback,
) callconv(.c) void {
    _ = _worker;
    if (callback == null) {
        return;
    }

    switch (poll_mode) {
        .success => callback.?(user_data, &success_buffer, null),
        .failure => callback.?(user_data, null, &failure_buffer),
        .shutdown => callback.?(user_data, null, null),
    }
}

fn testByteArrayFree(
    runtime_ptr: ?*core.RuntimeOpaque,
    bytes: ?*const core.ByteArray,
) callconv(.c) void {
    _ = runtime_ptr;
    _ = bytes;
}

fn testWorkflowCompletionCallback(
    worker_ptr: ?*core.WorkerOpaque,
    completion: core.ByteArrayRef,
    user_data: ?*anyopaque,
    callback: core.WorkerCallback,
) callconv(.c) void {
    _ = worker_ptr;
    completion_record_count += 1;
    recordCompletionPayload(completion);
    if (callback) |cb| {
        cb(user_data, null);
    }
}

pub fn installWorkerPollStub() void {
    core.ensureExternalApiInstalled();
    resetPollState();
    core.api.worker_poll_workflow_activation = testPollCallback;
    core.api.worker_poll_activity_task = testPollCallback;
    core.api.byte_array_free = testByteArrayFree;
}

pub fn setWorkerPollMode(mode: PollMode) void {
    poll_mode = mode;
}

pub fn resetWorkerState() void {
    resetPollState();
    resetCompletionState();
    test_runtime_handle.destroying = false;
    test_runtime_handle.pending_connects = 0;
    test_worker_handle.destroy_state = .idle;
    test_worker_handle.buffers_released = false;
    test_worker_handle.runtime = &test_runtime_handle;
    test_worker_handle.client = null;
    test_worker_handle.core_worker = @as(?*core.WorkerOpaque, @ptrCast(&fake_worker_storage));
    test_worker_handle.destroy_reclaims_allocation = false;
    test_worker_handle.owns_allocation = false;
    test_worker_handle.pending_polls = 0;
    poll_mode = .success;
}

pub fn installWorkerCompletionStub() void {
    core.ensureExternalApiInstalled();
    resetCompletionState();
    core.worker_complete_workflow_activation = testWorkflowCompletionCallback;
    core.runtime_byte_array_free = testByteArrayFree;
}

pub fn setWorkerPollWorkflowSuccessPayload(bytes: []const u8) i32 {
    return if (applyPollSuccessPayload(bytes)) 0 else -1;
}

pub fn takeWorkerCompletionPayload() ?*byte_array.ByteArray {
    const pointer = completion_record;
    completion_record = null;
    return pointer;
}

pub fn workerCompletionCount() usize {
    return completion_record_count;
}

pub fn workerCompletionSize() usize {
    if (completion_record) |array_ptr| {
        return array_ptr.size;
    }
    return 0;
}

pub fn consumeWorkerCompletion(dest: ?[*]u8, len: usize) i32 {
    const array_ptr_opt = completion_record orelse {
        return -1;
    };

    defer {
        completion_record = null;
        byte_array.free(array_ptr_opt);
    }

    if (array_ptr_opt.size != len) {
        return -1;
    }

    if (len == 0) {
        return 0;
    }

    if (dest == null) {
        return -1;
    }

    const source_ptr_opt = array_ptr_opt.data orelse {
        return -1;
    };

    const source = @as([*]const u8, @ptrCast(source_ptr_opt));
    const target = dest.?[0..len];
    @memcpy(target, source[0..len]);
    return 0;
}

pub fn workerHandle() *worker.WorkerHandle {
    return &test_worker_handle;
}
