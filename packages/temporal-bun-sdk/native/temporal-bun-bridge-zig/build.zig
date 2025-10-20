const std = @import("std");

const TemporalCrate = struct {
    package: []const u8,
    archive: []const u8,
};

const temporal_crates = [_]TemporalCrate{
    .{ .package = "temporal-sdk-core", .archive = "temporal_sdk_core" },
    .{ .package = "temporal-sdk-core-c-bridge", .archive = "temporal_sdk_core_c_bridge" },
    .{ .package = "temporal-client", .archive = "temporal_client" },
    .{ .package = "temporal-sdk-core-api", .archive = "temporal_sdk_core_api" },
    .{ .package = "temporal-sdk-core-protos", .archive = "temporal_sdk_core_protos" },
};

const temporal_vendor_root = "../../vendor/sdk-core";

const BuildError = error{
    UnsupportedTarget,
    ArchiveNotFound,
};

const TargetLayout = struct {
    cargo_triple: []const u8,
    platform_dir: []const u8,
    arch_dir: []const u8,
};

fn resolveTargetLayout(target: std.Target) BuildError!TargetLayout {
    const arch_dir = switch (target.cpu.arch) {
        .aarch64 => "arm64",
        .x86_64 => "x64",
        else => return BuildError.UnsupportedTarget,
    };

    return switch (target.os.tag) {
        .macos => switch (target.cpu.arch) {
            .aarch64 => TargetLayout{
                .cargo_triple = "aarch64-apple-darwin",
                .platform_dir = "darwin",
                .arch_dir = arch_dir,
            },
            .x86_64 => TargetLayout{
                .cargo_triple = "x86_64-apple-darwin",
                .platform_dir = "darwin",
                .arch_dir = arch_dir,
            },
            else => unreachable,
        },
        .linux => blk: {
            if (target.abi != .gnu) return BuildError.UnsupportedTarget;
            const layout = switch (target.cpu.arch) {
                .aarch64 => TargetLayout{
                    .cargo_triple = "aarch64-unknown-linux-gnu",
                    .platform_dir = "linux",
                    .arch_dir = arch_dir,
                },
                .x86_64 => TargetLayout{
                    .cargo_triple = "x86_64-unknown-linux-gnu",
                    .platform_dir = "linux",
                    .arch_dir = arch_dir,
                },
                else => unreachable,
            };
            break :blk layout;
        },
        else => BuildError.UnsupportedTarget,
    };
}

fn getProfileDir(optimize: std.builtin.OptimizeMode) []const u8 {
    return switch (optimize) {
        .Debug => "debug",
        else => "release",
    };
}

fn formatArchiveFilename(b: *std.Build, archive_name: []const u8) []const u8 {
    return b.fmt("lib{s}.a", .{archive_name});
}

fn archivePath(
    b: *std.Build,
    cargo_target: []const u8,
    profile_dir: []const u8,
    archive_name: []const u8,
) std.Build.LazyPath {
    return b.path(b.pathJoin(&.{
        temporal_vendor_root,
        "target",
        cargo_target,
        profile_dir,
        formatArchiveFilename(b, archive_name),
    }));
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const resolved_target = target.result;
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

    const target_layout = resolveTargetLayout(resolved_target) catch {
        std.debug.panic(
            "Unsupported target {s}-{s} for Temporal Rust linkage.",
            .{ @tagName(resolved_target.cpu.arch), @tagName(resolved_target.os.tag) },
        );
    };
    const default_install_subpath = b.fmt("{s}/{s}/{s}", .{
        target_layout.platform_dir,
        target_layout.arch_dir,
        lib.out_filename,
    });

    var install_options: std.Build.Step.InstallArtifact.Options = .{};
    if (install_subpath) |subpath| {
        install_options.dest_sub_path = subpath;
    } else {
        install_options.dest_sub_path = default_install_subpath;
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

    const vendor_path = b.build_root.join(b.allocator, &.{temporal_vendor_root}) catch @panic("failed to resolve vendor path");
    defer b.allocator.free(vendor_path);
    var vendor_dir = std.fs.cwd().openDir(vendor_path, .{}) catch |err| {
        std.debug.panic(
            "Temporal SDK core checkout not found at {s} ({s}). Run the vendor setup in packages/temporal-bun-sdk/README.md.",
            .{ temporal_vendor_root, @errorName(err) },
        );
    };
    defer vendor_dir.close();

    _ = b.findProgram(&.{"cargo"}, &.{}) catch {
        std.debug.panic("Cargo toolchain is required to build Temporal core artifacts.", .{});
    };
    const profile_dir = getProfileDir(optimize);

    for (temporal_crates) |crate_info| {
        const cargo_step = b.addSystemCommand(&.{ "cargo", "rustc" });
        cargo_step.setName(b.fmt("cargo rustc ({s})", .{crate_info.package}));
        cargo_step.setCwd(b.path(temporal_vendor_root));
        cargo_step.addArgs(&.{ "-p", crate_info.package, "--crate-type", "staticlib", "--target", target_layout.cargo_triple });
        if (optimize != .Debug) cargo_step.addArg("--release");

        lib.step.dependOn(&cargo_step.step);
        unit_tests.step.dependOn(&cargo_step.step);

        const archive = archivePath(b, target_layout.cargo_triple, profile_dir, crate_info.archive);
        lib.addObjectFile(archive);
        unit_tests.addObjectFile(archive);
    }

    if (resolved_target.os.tag == .linux) {
        // Rust's panic/unwind support expects these symbols from libunwind when linking static archives.
        lib.linkSystemLibrary("unwind");
        unit_tests.linkSystemLibrary("unwind");
    }

    const test_step = b.step("test", "Run Zig bridge tests (stub)");
    test_step.dependOn(&b.addRunArtifact(unit_tests).step);
}
