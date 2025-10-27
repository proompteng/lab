const std = @import("std");
const common = @import("common.zig");
const errors = @import("../errors.zig");
const core = @import("../core.zig");

const grpc = common.grpc;

pub fn updateHeaders(_client: ?*common.ClientHandle, _payload: []const u8) i32 {
    if (_client == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: updateHeaders received null client",
            .details = null,
        });
        return -1;
    }

    if (_payload.len == 0) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: updateHeaders payload must be non-empty JSON",
            .details = null,
        });
        return -1;
    }

    const client_ptr = _client.?;

    const runtime_handle = client_ptr.runtime orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: updateHeaders missing runtime handle",
            .details = null,
        });
        return -1;
    };

    if (runtime_handle.core_runtime == null) {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: runtime core handle is not initialized",
            .details = null,
        });
        return -1;
    }

    const core_client = client_ptr.core_client orelse {
        errors.setStructuredErrorJson(.{
            .code = grpc.failed_precondition,
            .message = "temporal-bun-bridge-zig: client core handle is not initialized",
            .details = null,
        });
        return -1;
    };

    const allocator = std.heap.c_allocator;

    var parsed = std.json.parseFromSlice(std.json.Value, allocator, _payload, .{}) catch |err| {
        var scratch: [160]u8 = undefined;
        const message = std.fmt.bufPrint(
            &scratch,
            "temporal-bun-bridge-zig: updateHeaders payload must be valid JSON: {}",
            .{err},
        ) catch "temporal-bun-bridge-zig: updateHeaders payload must be valid JSON";
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = message,
            .details = null,
        });
        return -1;
    };
    defer parsed.deinit();

    if (parsed.value != .object) {
        errors.setStructuredErrorJson(.{
            .code = grpc.invalid_argument,
            .message = "temporal-bun-bridge-zig: updateHeaders payload must be a JSON object",
            .details = null,
        });
        return -1;
    }

    var headers_object = parsed.value.object;
    const entry_count = headers_object.count();

    if (entry_count == 0) {
        core.api.client_update_metadata(core_client, common.emptyByteArrayRef());
        errors.setLastError(""[0..0]);
        return 0;
    }

    var keys = std.ArrayList([]const u8).initCapacity(allocator, entry_count) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate updateHeaders key list",
            .details = null,
        });
        return -1;
    };
    defer keys.deinit(allocator);

    {
        var iterator = headers_object.iterator();
        while (iterator.next()) |entry| {
            if (entry.value_ptr.* != .string) {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: updateHeaders values must be strings",
                    .details = null,
                });
                return -1;
            }
            keys.appendAssumeCapacity(entry.key_ptr.*);
        }
    }

    var pivot: usize = 1;
    while (pivot < keys.items.len) : (pivot += 1) {
        const current = keys.items[pivot];
        var insert = pivot;
        while (insert > 0 and std.mem.lessThan(u8, current, keys.items[insert - 1])) {
            keys.items[insert] = keys.items[insert - 1];
            insert -= 1;
        }
        keys.items[insert] = current;
    }

    var metadata_builder = std.ArrayListUnmanaged(u8){};
    defer metadata_builder.deinit(allocator);

    for (keys.items, 0..) |key, index| {
        const value_ptr = headers_object.getPtr(key) orelse continue;
        const value_slice = switch (value_ptr.*) {
            .string => |s| s,
            else => {
                errors.setStructuredErrorJson(.{
                    .code = grpc.invalid_argument,
                    .message = "temporal-bun-bridge-zig: updateHeaders values must be strings",
                    .details = null,
                });
                return -1;
            },
        };

        metadata_builder.appendSlice(allocator, key) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.resource_exhausted,
                .message = "temporal-bun-bridge-zig: failed to encode updateHeaders metadata",
                .details = null,
            });
            return -1;
        };
        metadata_builder.append(allocator, '\n') catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.resource_exhausted,
                .message = "temporal-bun-bridge-zig: failed to encode updateHeaders metadata",
                .details = null,
            });
            return -1;
        };
        metadata_builder.appendSlice(allocator, value_slice) catch {
            errors.setStructuredErrorJson(.{
                .code = grpc.resource_exhausted,
                .message = "temporal-bun-bridge-zig: failed to encode updateHeaders metadata",
                .details = null,
            });
            return -1;
        };

        if (index + 1 < entry_count) {
            metadata_builder.append(allocator, '\n') catch {
                errors.setStructuredErrorJson(.{
                    .code = grpc.resource_exhausted,
                    .message = "temporal-bun-bridge-zig: failed to encode updateHeaders metadata",
                    .details = null,
                });
                return -1;
            };
        }
    }

    const metadata_bytes = metadata_builder.toOwnedSlice(allocator) catch {
        errors.setStructuredErrorJson(.{
            .code = grpc.resource_exhausted,
            .message = "temporal-bun-bridge-zig: failed to allocate encoded metadata",
            .details = null,
        });
        return -1;
    };
    defer allocator.free(metadata_bytes);

    core.api.client_update_metadata(core_client, common.makeByteArrayRef(metadata_bytes));
    errors.setLastError(""[0..0]);
    return 0;
}
