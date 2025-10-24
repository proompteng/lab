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

const temporal_cache_root = "../../.temporal-libs-cache";

const BuildError = error{
    UnsupportedTarget,
    ArchiveNotFound,
};

fn formatArchiveFilename(b: *std.Build, archive_name: []const u8) []const u8 {
    return b.fmt("lib{s}.a", .{archive_name});
}

fn prebuiltArchivePath(
    b: *std.Build,
    version: []const u8,
    platform: []const u8,
    archive_name: []const u8,
) std.Build.LazyPath {
    return b.path(b.pathJoin(&.{
        temporal_cache_root,
        version,
        platform,
        formatArchiveFilename(b, archive_name),
    }));
}

fn checkPrebuiltLibrariesExist(
    b: *std.Build,
    version: []const u8,
    platform: []const u8,
) bool {
    for (temporal_crates) |crate_info| {
        const archive_path = b.pathJoin(&.{
            temporal_cache_root,
            version,
            platform,
            formatArchiveFilename(b, crate_info.archive),
        });

        const full_path = b.build_root.join(b.allocator, &.{archive_path}) catch {
            return false;
        };
        defer b.allocator.free(full_path);

        // Check if file exists
        std.fs.cwd().access(full_path, .{}) catch {
            return false;
        };
    }
    return true;
}

fn getPlatformString(target: std.Target) ?[]const u8 {
    return switch (target.os.tag) {
        .macos => switch (target.cpu.arch) {
            .aarch64 => "macos-arm64",
            .x86_64 => "macos-x64",
            else => null,
        },
        .linux => switch (target.cpu.arch) {
            .aarch64 => "linux-arm64",
            .x86_64 => "linux-x64",
            else => null,
        },
        else => null,
    };
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const install_subpath = b.option(
        []const u8,
        "install-subpath",
        "Relative path (from the lib install dir) that overrides where the compiled bridge dylib/so should be staged.",
    );
    const allocator = b.allocator;

    const lib_module = b.createModule(.{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    const include_dir = b.path("include");
    lib_module.addIncludePath(include_dir);

    if (std.process.getEnvVarOwned(allocator, "TEMPORAL_CORE_INCLUDE_DIR")) |include_dir_override| {
        defer allocator.free(include_dir_override);
        lib_module.addIncludePath(.{ .cwd_relative = include_dir_override });
    } else |_| {}

    const lib = b.addLibrary(.{
        .name = "temporal_bun_bridge_zig",
        .root_module = lib_module,
        .linkage = .dynamic,
    });
    lib.addIncludePath(include_dir);

    if (std.process.getEnvVarOwned(allocator, "TEMPORAL_CORE_LIB_DIR")) |lib_dir| {
        defer allocator.free(lib_dir);
        lib.addLibraryPath(.{ .cwd_relative = lib_dir });
        // These libraries map to the Temporal core Rust build artifacts once generated via cbindgen.
        lib.linkSystemLibrary("temporal_sdk_core_c_bridge");
        lib.linkSystemLibrary("temporal_sdk_core");
    } else |_| {}

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

    const resolved_target = target.result;

    // Check for USE_PREBUILT_LIBS environment variable
    const use_prebuilt_libs = std.process.getEnvVarOwned(b.allocator, "USE_PREBUILT_LIBS") catch null;
    defer if (use_prebuilt_libs) |value| b.allocator.free(value);

    const should_use_prebuilt = if (use_prebuilt_libs) |value|
        std.mem.eql(u8, value, "true") or std.mem.eql(u8, value, "1")
    else
        false;

    // Get version for pre-built libraries (default to "latest")
    const prebuilt_version = std.process.getEnvVarOwned(b.allocator, "TEMPORAL_LIBS_VERSION") catch null;
    defer if (prebuilt_version) |value| b.allocator.free(value);
    const version = prebuilt_version orelse "latest";

    // Get platform string for pre-built libraries
    const platform = getPlatformString(resolved_target);

    if (!should_use_prebuilt) {
        std.debug.print("✗ USE_PREBUILT_LIBS=false is no longer supported.\n", .{});
        std.debug.print("   The Rust bridge has been removed; pre-built Temporal static libraries are required.\n", .{});
        std.debug.print("   Run 'bun run scripts/download-temporal-libs.ts download' to fetch the libraries, then rerun the build.\n", .{});
        std.debug.panic("Pre-built libraries are mandatory for the Zig bridge", .{});
    }

    if (platform == null) {
        std.debug.print("✗ Platform {s}-{s} is not supported for pre-built libraries\n", .{ @tagName(resolved_target.cpu.arch), @tagName(resolved_target.os.tag) });
        std.debug.print("   Supported platforms: linux-arm64, linux-x64, macos-arm64\n", .{});
        std.debug.panic("Unsupported target for Zig bridge build", .{});
    }

    if (!checkPrebuiltLibrariesExist(b, version, platform.?)) {
        std.debug.print("✗ Pre-built libraries not found for {s} (version: {s})\n", .{ platform.?, version });
        std.debug.print("   Run 'bun run scripts/download-temporal-libs.ts download' to fetch the Temporal static libraries.\n", .{});
        std.debug.panic("Missing Temporal static libraries required by the Zig bridge", .{});
    }

    std.debug.print("✓ Using pre-built libraries for platform: {s} (version: {s})\n", .{ platform.?, version });

    // Link pre-built libraries
    for (temporal_crates) |crate_info| {
        const archive = prebuiltArchivePath(b, version, platform.?, crate_info.archive);
        std.debug.print("  → Linking pre-built library: lib{s}.a\n", .{crate_info.archive});
        lib.addObjectFile(archive);
        unit_tests.addObjectFile(archive);
    }

    if (resolved_target.os.tag == .linux) {
        // Rust's panic/unwind support expects these symbols from libunwind when linking static archives.
        lib.linkSystemLibrary("unwind");
        unit_tests.linkSystemLibrary("unwind");
    } else if (resolved_target.os.tag == .macos) {
        const frameworks = [_][]const u8{
            "Security",
            "CoreFoundation",
            "SystemConfiguration",
            "IOKit",
        };
        for (frameworks) |fw| {
            lib.linkFramework(fw);
            unit_tests.linkFramework(fw);
        }
    }

    const test_step = b.step("test", "Run Zig bridge tests (stub)");
    test_step.dependOn(&b.addRunArtifact(unit_tests).step);
}
