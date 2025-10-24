const std = @import("std");
const testing = std.testing;

// Test the StringArena utility directly since it's self-contained
const StringArena = struct {
    allocator: std.mem.Allocator,
    store: std.ArrayListUnmanaged([]u8) = .{},

    pub fn init(allocator: std.mem.Allocator) StringArena {
        return .{ .allocator = allocator, .store = .{} };
    }

    pub fn dup(self: *StringArena, bytes: []const u8) ![]const u8 {
        const copy = try self.allocator.alloc(u8, bytes.len);
        @memcpy(copy, bytes);
        try self.store.append(self.allocator, copy);
        return copy;
    }

    pub fn deinit(self: *StringArena) void {
        for (self.store.items) |buf| {
            self.allocator.free(buf);
        }
        self.store.deinit(self.allocator);
    }
};

test "StringArena duplicates and manages strings" {
    var arena = StringArena.init(testing.allocator);
    defer arena.deinit();

    const original = "test-string";
    const copy = try arena.dup(original);
    
    try testing.expectEqualStrings(original, copy);
    try testing.expect(copy.ptr != original.ptr); // Different memory
}

test "StringArena handles empty strings" {
    var arena = StringArena.init(testing.allocator);
    defer arena.deinit();

    const copy = try arena.dup("");
    try testing.expectEqualStrings("", copy);
}

test "StringArena manages multiple strings" {
    var arena = StringArena.init(testing.allocator);
    defer arena.deinit();

    const copy1 = try arena.dup("first");
    const copy2 = try arena.dup("second");
    
    try testing.expectEqualStrings("first", copy1);
    try testing.expectEqualStrings("second", copy2);
}

// Test the memory safety pattern used in clientStartWorkflowCallback fix
test "memory copy before free pattern" {
    const allocator = testing.allocator;
    
    // Simulate the original data (like core-managed memory)
    const original_data = try allocator.alloc(u8, 10);
    defer allocator.free(original_data);
    @memcpy(original_data, "test-data\x00");
    
    // Get a slice view (like byteArraySlice would return)
    const slice = original_data[0..9]; // Exclude null terminator
    
    // Copy BEFORE freeing (the fix we implemented)
    const copy = try allocator.alloc(u8, slice.len);
    defer allocator.free(copy);
    @memcpy(copy, slice);
    
    // Now it's safe to "free" the original (simulated)
    // In real code: core.api.byte_array_free(original_ptr);
    
    // Verify the copy is intact
    try testing.expectEqualStrings("test-data", copy);
}
