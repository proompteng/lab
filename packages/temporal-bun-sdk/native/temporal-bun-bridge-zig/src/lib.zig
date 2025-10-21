const std = @import("std");
const errors = @import("errors.zig");
const runtime = @import("runtime.zig");
const client = @import("client.zig");
const byte_array = @import("byte_array.zig");
const pending = @import("pending.zig");
const worker = @import("worker.zig");

fn sliceFrom(ptr: ?[*]const u8, len: u64) []const u8 {
    if (ptr == null or len == 0) {
        return ""[0..0];
    }

    const size: usize = @intCast(len);
    return ptr.?[0..size];
}

fn sliceFromI32(ptr: ?[*]const u8, len: i32) []const u8 {
    if (len <= 0) {
        return ""[0..0];
    }

    const size: u64 = @intCast(len);
    return sliceFrom(ptr, size);
}

fn toPendingHandle(ptr: ?*anyopaque) ?*pending.PendingHandle {
    return if (ptr) |nonNull| @as(?*pending.PendingHandle, @ptrCast(@alignCast(nonNull))) else null;
}

pub export fn temporal_bun_runtime_new(payload_ptr: ?[*]const u8, len: u64) ?*runtime.RuntimeHandle {
    const payload = sliceFrom(payload_ptr, len);
    return runtime.create(payload);
}

pub export fn temporal_bun_runtime_free(handle: ?*runtime.RuntimeHandle) void {
    runtime.destroy(handle);
}

pub export fn temporal_bun_runtime_update_telemetry(
    runtime_ptr: ?*runtime.RuntimeHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return runtime.updateTelemetry(runtime_ptr, payload);
}

pub export fn temporal_bun_runtime_set_logger(
    runtime_ptr: ?*runtime.RuntimeHandle,
    callback_ptr: ?*anyopaque,
) i32 {
    return runtime.setLogger(runtime_ptr, callback_ptr);
}

pub export fn temporal_bun_error_message(len_ptr: ?*u64) ?[*]u8 {
    return errors.takeForFfi(len_ptr);
}

pub export fn temporal_bun_error_free(ptr: ?[*]u8, len: u64) void {
    errors.freeFfiBuffer(ptr, len);
}

pub export fn temporal_bun_client_connect_async(
    runtime_ptr: ?*runtime.RuntimeHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.connectAsync(runtime_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_client_free(handle: ?*client.ClientHandle) void {
    client.destroy(handle);
}

pub export fn temporal_bun_client_describe_namespace_async(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.describeNamespaceAsync(client_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_client_update_headers(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return client.updateHeaders(client_ptr, payload);
}

pub export fn temporal_bun_pending_client_poll(_handle: ?*anyopaque) i32 {
    const handle = toPendingHandle(_handle);
    return pending.poll(handle);
}

pub export fn temporal_bun_pending_client_consume(_handle: ?*anyopaque) ?*client.ClientHandle {
    const handle = toPendingHandle(_handle);
    if (pending.consume(handle)) |payload| {
        return @as(?*client.ClientHandle, @ptrCast(@alignCast(payload)));
    }
    return null;
}

pub export fn temporal_bun_pending_client_free(_handle: ?*anyopaque) void {
    const handle = toPendingHandle(_handle);
    pending.free(handle);
}

pub export fn temporal_bun_pending_byte_array_poll(_handle: ?*anyopaque) i32 {
    const handle = toPendingHandle(_handle);
    return pending.poll(handle);
}

pub export fn temporal_bun_pending_byte_array_consume(_handle: ?*anyopaque) ?*byte_array.ByteArray {
    const handle = toPendingHandle(_handle);
    if (pending.consume(handle)) |payload| {
        return @as(?*byte_array.ByteArray, @ptrCast(@alignCast(payload)));
    }
    return null;
}

pub export fn temporal_bun_pending_byte_array_free(_handle: ?*anyopaque) void {
    const handle = toPendingHandle(_handle);
    pending.free(handle);
}

pub export fn temporal_bun_byte_array_free(handle: ?*byte_array.ByteArray) void {
    byte_array.free(handle);
}

pub export fn temporal_bun_client_start_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*byte_array.ByteArray {
    const payload = sliceFrom(payload_ptr, len);
    return client.startWorkflow(client_ptr, payload);
}

pub export fn temporal_bun_client_terminate_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return client.terminateWorkflow(client_ptr, payload);
}

pub export fn temporal_bun_client_signal_with_start(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*byte_array.ByteArray {
    const payload = sliceFrom(payload_ptr, len);
    return client.signalWithStart(client_ptr, payload);
}

pub export fn te_worker_create(
    client_handle: u64,
    task_queue_ptr: ?[*]const u8,
    task_queue_len: i32,
    out_worker: ?*u64,
) i32 {
    const task_queue = sliceFromI32(task_queue_ptr, task_queue_len);
    return worker.createStubWorker(client_handle, task_queue, out_worker);
}

pub export fn te_worker_set_concurrency(worker_handle: u64, concurrency: i32) i32 {
    return worker.setStubConcurrency(worker_handle, concurrency);
}

pub export fn te_act_poll(
    worker_handle: u64,
    out_ptr: ?*[*]const u8,
    out_len: ?*i32,
) i32 {
    return worker.pollStubActivity(worker_handle, out_ptr, out_len);
}

pub export fn te_act_heartbeat(
    worker_handle: u64,
    token_ptr: ?[*]const u8,
    token_len: i32,
    details_ptr: ?[*]const u8,
    details_len: i32,
) i32 {
    return worker.recordStubHeartbeat(worker_handle, token_ptr, token_len, details_ptr, details_len);
}

pub export fn te_act_is_cancelled(
    worker_handle: u64,
    token_ptr: ?[*]const u8,
    token_len: i32,
    out_bool: ?*i32,
) i32 {
    return worker.stubIsCancelled(worker_handle, token_ptr, token_len, out_bool);
}

pub export fn te_act_complete(
    worker_handle: u64,
    token_ptr: ?[*]const u8,
    token_len: i32,
    result_ptr: ?[*]const u8,
    result_len: i32,
) i32 {
    return worker.stubCompleteActivity(worker_handle, token_ptr, token_len, result_ptr, result_len);
}

pub export fn te_act_fail(
    worker_handle: u64,
    token_ptr: ?[*]const u8,
    token_len: i32,
    err_ptr: ?[*]const u8,
    err_len: i32,
) i32 {
    return worker.stubFailActivity(worker_handle, token_ptr, token_len, err_ptr, err_len);
}

pub export fn te_worker_shutdown(worker_handle: u64, drain_seconds: i32) i32 {
    return worker.stubShutdownWorker(worker_handle, drain_seconds);
}

pub export fn temporal_bun_client_query_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.queryWorkflow(client_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_client_signal(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.signalWorkflow(client_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_client_cancel_workflow(
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*anyopaque {
    const payload = sliceFrom(payload_ptr, len);
    if (client.cancelWorkflow(client_ptr, payload)) |handle| {
        return @as(?*anyopaque, @ptrCast(handle));
    }
    return null;
}

pub export fn temporal_bun_worker_new(
    runtime_ptr: ?*runtime.RuntimeHandle,
    client_ptr: ?*client.ClientHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) ?*worker.WorkerHandle {
    const payload = sliceFrom(payload_ptr, len);
    return worker.create(runtime_ptr, client_ptr, payload);
}

pub export fn temporal_bun_worker_free(handle: ?*worker.WorkerHandle) void {
    worker.destroy(handle);
}

pub export fn temporal_bun_worker_poll_workflow_task(handle: ?*worker.WorkerHandle) ?*anyopaque {
    if (worker.pollWorkflowTask(handle)) |pending_handle| {
        return @as(?*anyopaque, @ptrCast(pending_handle));
    }
    return null;
}

pub export fn temporal_bun_worker_complete_workflow_task(
    handle: ?*worker.WorkerHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    if (len > 0 and payload_ptr == null) {
        errors.setLastError("temporal-bun-bridge-zig: worker completion payload pointer was null");
        return -1;
    }
    const payload = sliceFrom(payload_ptr, len);
    return worker.completeWorkflowTask(handle, payload);
}

pub export fn temporal_bun_worker_poll_activity_task(handle: ?*worker.WorkerHandle) ?*anyopaque {
    if (worker.pollActivityTask(handle)) |pending_handle| {
        return @as(?*anyopaque, @ptrCast(pending_handle));
    }
    return null;
}

pub export fn temporal_bun_worker_complete_activity_task(
    handle: ?*worker.WorkerHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return worker.completeActivityTask(handle, payload);
}

pub export fn temporal_bun_worker_record_activity_heartbeat(
    handle: ?*worker.WorkerHandle,
    payload_ptr: ?[*]const u8,
    len: u64,
) i32 {
    const payload = sliceFrom(payload_ptr, len);
    return worker.recordActivityHeartbeat(handle, payload);
}

pub export fn temporal_bun_worker_initiate_shutdown(handle: ?*worker.WorkerHandle) i32 {
    return worker.initiateShutdown(handle);
}

pub export fn temporal_bun_worker_finalize_shutdown(handle: ?*worker.WorkerHandle) i32 {
    return worker.finalizeShutdown(handle);
}

test {
    _ = @import("client_describe_namespace_test.zig");
}
