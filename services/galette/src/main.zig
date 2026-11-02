const std = @import("std");

const allocator_policy = std.heap.GeneralPurposeAllocator(.{});

const Response = struct {
    status_code: u16,
    reason: []const u8,
    body: []const u8,
    content_type: []const u8 = "text/plain; charset=utf-8",
};

const address_resolve_error = error{
    AddressResolutionFailed,
};

pub fn main() !void {
    var gpa = allocator_policy{};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const listen_address = try resolveListenAddress(allocator);

    var server = try std.net.Address.listen(listen_address, .{ .reuse_address = true });
    defer server.deinit();

    std.log.info("galette listening on {f}", .{listen_address});

    while (true) {
        var conn = try server.accept();
        handleConnection(&conn, allocator) catch |err| {
            std.log.err("connection error: {s}", .{@errorName(err)});
        };
    }
}

fn resolveListenAddress(allocator: std.mem.Allocator) !std.net.Address {
    const port = try resolvePort(allocator);
    const host_owned = std.process.getEnvVarOwned(allocator, "ADDRESS") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
    defer if (host_owned) |host| allocator.free(host);
    const host = if (host_owned) |value| value else "0.0.0.0";

    return std.net.Address.resolveIp(host, port) catch address_resolve_error.AddressResolutionFailed;
}

fn resolvePort(allocator: std.mem.Allocator) !u16 {
    const port_owned = std.process.getEnvVarOwned(allocator, "PORT") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
    defer if (port_owned) |value| allocator.free(value);

    if (port_owned) |buffer| {
        return try std.fmt.parseInt(u16, buffer, 10);
    }

    return 8080;
}

fn handleConnection(conn: *std.net.Server.Connection, allocator: std.mem.Allocator) !void {
    defer conn.stream.close();

    var request_line = std.array_list.Managed(u8).init(allocator);
    defer request_line.deinit();

    var buffer: [1024]u8 = undefined;
    var newline_found = false;
    var headers = std.array_list.Managed(u8).init(allocator);
    defer headers.deinit();

    while (!newline_found) {
        const read_bytes = try conn.stream.read(&buffer);
        if (read_bytes == 0) return;

        for (buffer[0..read_bytes], 0..) |byte, index| {
            if (byte == '\n') {
                newline_found = true;
                if (index + 1 < read_bytes) {
                    try headers.appendSlice(buffer[index + 1 .. read_bytes]);
                }
                break;
            }

            if (byte == '\r') continue;
            try request_line.append(byte);
        }

        if (request_line.items.len > 8192) {
            return;
        }
    }

    if (request_line.items.len == 0) return;

    var parts = std.mem.tokenizeScalar(u8, request_line.items, ' ');
    const method = parts.next() orelse return;
    const raw_path = parts.next() orelse "/";

    const response = route(method, raw_path);

    while (!headersComplete(headers.items)) {
        const bytes = try conn.stream.read(&buffer);
        if (bytes == 0) break;
        try headers.appendSlice(buffer[0..bytes]);
        if (headers.items.len > 32768) return;
    }

    var header_buf: [256]u8 = undefined;
    const header = try std.fmt.bufPrint(
        &header_buf,
        "HTTP/1.1 {d} {s}\r\nContent-Type: {s}\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n",
        .{ response.status_code, response.reason, response.content_type, response.body.len },
    );

    try conn.stream.writeAll(header);
    try conn.stream.writeAll(response.body);
}

fn headersComplete(headers: []const u8) bool {
    return std.mem.indexOf(u8, headers, "\r\n\r\n") != null or
        std.mem.indexOf(u8, headers, "\n\n") != null;
}

pub fn route(method: []const u8, path: []const u8) Response {
    if (!std.ascii.eqlIgnoreCase(method, "GET")) {
        return Response{
            .status_code = 405,
            .reason = "Method Not Allowed",
            .body = "method not allowed\n",
        };
    }

    if (std.mem.eql(u8, path, "/") or std.mem.eql(u8, path, "")) {
        return Response{
            .status_code = 200,
            .reason = "OK",
            .body = "Bonjour du service Galette!\n",
        };
    }

    if (std.mem.eql(u8, path, "/health/liveness") or std.mem.eql(u8, path, "/health/readiness")) {
        return Response{
            .status_code = 200,
            .reason = "OK",
            .body = "ok\n",
        };
    }

    return Response{
        .status_code = 404,
        .reason = "Not Found",
        .body = "not found\n",
    };
}

test "route handles root" {
    const res = route("GET", "/");
    try std.testing.expectEqual(@as(u16, 200), res.status_code);
    try std.testing.expect(std.mem.eql(u8, "Bonjour du service Galette!\n", res.body));
}

test "route handles health endpoints" {
    const res = route("GET", "/health/liveness");
    try std.testing.expectEqual(@as(u16, 200), res.status_code);
    try std.testing.expect(std.mem.eql(u8, "ok\n", res.body));
}

test "route rejects unsupported methods" {
    const res = route("POST", "/");
    try std.testing.expectEqual(@as(u16, 405), res.status_code);
}

test "headersComplete detects terminators carried from the request-line read" {
    try std.testing.expect(headersComplete("Host: example\r\n\r\n"));
    try std.testing.expect(headersComplete("Host: example\n\n"));
    try std.testing.expect(!headersComplete("Host: example\r\n"));
}
