const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const install_subpath = b.option(
        []const u8,
        "install-subpath",
        "Relative path from the lib install dir where the compiled bridge should be staged.",
    );

    const lib = b.addSharedLibrary(.{
        .name = "temporal_bun_bridge_zig",
        .root_source_file = b.path("src/ffi.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });

    var install_options: std.Build.Step.InstallArtifact.Options = .{};
    if (install_subpath) |subpath| {
        install_options.dest_sub_path = subpath;
    }

    const install_step = b.addInstallArtifact(lib, install_options);
    b.getInstallStep().dependOn(&install_step.step);

    const tests = b.addTest(.{
        .root_source_file = b.path("src/ffi.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });

    const run_tests = b.addRunArtifact(tests);
    run_tests.cwd = .{ .cwd_relative = "." };
    const test_step = b.step("test", "Run Zig FFI contract tests");
    test_step.dependOn(&run_tests.step);
}
