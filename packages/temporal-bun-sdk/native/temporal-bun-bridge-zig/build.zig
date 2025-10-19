const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const install_subpath = b.option(
        []const u8,
        "install-subpath",
        "Relative path (from the lib install dir) that overrides where the compiled bridge dylib/so should be staged.",
    );

    const lib_module = b.createModule(.{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const include_dir = b.path("include");
    lib_module.addIncludePath(include_dir);

    const lib = b.addLibrary(.{
        .name = "temporal_bun_bridge_zig",
        .root_module = lib_module,
        .linkage = .dynamic,
    });
    lib.addIncludePath(include_dir);

    // TODO(codex, zig-pack-01): Link Temporal Rust static libraries emitted by cargo+cbindgen.

    var install_options: std.Build.Step.InstallArtifact.Options = .{};
    if (install_subpath) |subpath| {
        install_options.dest_sub_path = subpath;
    }
    const install = b.addInstallArtifact(lib, install_options);
    b.getInstallStep().dependOn(&install.step);

    const test_module = b.createModule(.{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_module.addIncludePath(include_dir);

    const unit_tests = b.addTest(.{
        .root_module = test_module,
    });

    const test_step = b.step("test", "Run Zig bridge tests (stub)");
    test_step.dependOn(&b.addRunArtifact(unit_tests).step);
}
