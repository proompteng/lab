const std = @import("std");
const worker = @import("worker.zig");
const runtime = @import("runtime.zig");
const core = @import("core.zig");

pub const PollMode = enum(u8) {
    success = 0,
    failure = 1,
    shutdown = 2,
};

var fake_runtime_storage: usize = 0;
var fake_worker_storage: usize = 0;

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
    .core_worker = @as(?*core.WorkerOpaque, @ptrCast(&fake_worker_storage)),
    .poll_lock = .{},
    .poll_condition = .{},
    .pending_polls = 0,
    .destroying = false,
};

const success_payload = "stub-activation";
const failure_message = "stub-poll-failure";

var success_buffer = core.ByteArray{
    .data = success_payload.ptr,
    .size = success_payload.len,
    .cap = success_payload.len,
    .disable_free = true,
};

var failure_buffer = core.ByteArray{
    .data = failure_message.ptr,
    .size = failure_message.len,
    .cap = failure_message.len,
    .disable_free = true,
};

var poll_mode: PollMode = .success;

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

pub fn installWorkerPollStub() void {
    core.ensureExternalApiInstalled();
    core.api.worker_poll_workflow_activation = testPollCallback;
    core.api.worker_poll_activity_task = testPollCallback;
    core.api.byte_array_free = testByteArrayFree;
}

pub fn setWorkerPollMode(mode: PollMode) void {
    poll_mode = mode;
}

pub fn resetWorkerState() void {
    test_runtime_handle.destroying = false;
    test_runtime_handle.pending_connects = 0;
    test_worker_handle.destroying = false;
    test_worker_handle.pending_polls = 0;
    poll_mode = .success;
}

pub fn workerHandle() *worker.WorkerHandle {
    return &test_worker_handle;
}
