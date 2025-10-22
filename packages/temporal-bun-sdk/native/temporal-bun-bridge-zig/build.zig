const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const lib = b.addSharedLibrary(.{
        .name = "temporal_bun_bridge_zig",
        .root_source_file = b.path("src/ffi.zig"),
        .target = target,
        .optimize = optimize,
    });
    lib.linkLibC();

    const install = b.addInstallArtifact(lib, .{});
    b.getInstallStep().dependOn(&install.step);

    const tests = b.addTest(.{
        .root_source_file = b.path("src/ffi.zig"),
        .target = target,
        .optimize = optimize,
    });
    tests.linkLibC();

    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run Temporal Bun FFI contract tests");
    test_step.dependOn(&run_tests.step);
}
