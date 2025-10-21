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

fn checkVendorDirectoryExists(b: *std.Build) bool {
    const vendor_path = b.build_root.join(b.allocator, &.{temporal_vendor_root}) catch {
        return false;
    };
    defer b.allocator.free(vendor_path);

    // Check if vendor directory exists and contains expected structure
    std.fs.cwd().access(vendor_path, .{}) catch {
        return false;
    };

    // Check if Cargo.toml exists in vendor directory
    const cargo_toml_path = b.build_root.join(b.allocator, &.{ temporal_vendor_root, "Cargo.toml" }) catch {
        return false;
    };
    defer b.allocator.free(cargo_toml_path);

    std.fs.cwd().access(cargo_toml_path, .{}) catch {
        return false;
    };

    return true;
}

fn cargoArchivePath(
    b: *std.Build,
    target: std.Target,
    archive_name: []const u8,
) std.Build.LazyPath {
    const profile = "release";
    const target_dir = switch (target.os.tag) {
        .macos => switch (target.cpu.arch) {
            .aarch64 => "aarch64-apple-darwin",
            .x86_64 => "x86_64-apple-darwin",
            else => "unknown",
        },
        .linux => switch (target.cpu.arch) {
            .aarch64 => "aarch64-unknown-linux-gnu",
            .x86_64 => "x86_64-unknown-linux-gnu",
            else => "unknown",
        },
        else => "unknown",
    };

    return b.path(b.pathJoin(&.{
        temporal_vendor_root,
        "target",
        target_dir,
        profile,
        formatArchiveFilename(b, archive_name),
    }));
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

fn addCargoBuildStep(b: *std.Build, target: std.Target) *std.Build.Step.Run {
    const target_triple = switch (target.os.tag) {
        .macos => switch (target.cpu.arch) {
            .aarch64 => "aarch64-apple-darwin",
            .x86_64 => "x86_64-apple-darwin",
            else => "unknown-apple-darwin",
        },
        .linux => switch (target.cpu.arch) {
            .aarch64 => "aarch64-unknown-linux-gnu",
            .x86_64 => "x86_64-unknown-linux-gnu",
            else => "unknown-linux-gnu",
        },
        else => "unknown",
    };

    const cargo_build = b.addSystemCommand(&.{
        "cargo",
        "build",
        "--release",
        "--target",
        target_triple,
    });

    // Set working directory to vendor directory
    cargo_build.setCwd(b.path(temporal_vendor_root));

    // Add environment variables for cross-compilation if needed
    if (target.os.tag == .linux and target.cpu.arch == .aarch64) {
        cargo_build.setEnvironmentVariable("CC", "aarch64-linux-gnu-gcc");
        cargo_build.setEnvironmentVariable("CXX", "aarch64-linux-gnu-g++");
        cargo_build.setEnvironmentVariable("AR", "aarch64-linux-gnu-ar");
        cargo_build.setEnvironmentVariable("STRIP", "aarch64-linux-gnu-strip");
    }

    return cargo_build;
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

    // Determine build strategy with fallback support
    var use_prebuilt_libraries = false;
    var fallback_to_cargo = false;

    if (should_use_prebuilt and platform != null) {
        // Check if pre-built libraries actually exist
        if (checkPrebuiltLibrariesExist(b, version, platform.?)) {
            use_prebuilt_libraries = true;
            std.debug.print("✓ Using pre-built libraries for platform: {s} (version: {s})\n", .{ platform.?, version });
        } else {
            std.debug.print("⚠️  Pre-built libraries not found for {s} (version: {s})\n", .{ platform.?, version });
            std.debug.print("   Checking for vendor directory fallback...\n", .{});

            // Check if vendor directory exists for fallback
            if (checkVendorDirectoryExists(b)) {
                fallback_to_cargo = true;
                std.debug.print("✓ Found vendor directory, falling back to Cargo build\n", .{});
            } else {
                std.debug.print("✗ No vendor directory found for fallback\n", .{});
                std.debug.print("   Solutions:\n", .{});
                std.debug.print("   1. Run 'bun run libs:download' to download pre-built libraries\n", .{});
                std.debug.print("   2. Set up vendor directory with 'git submodule update --init --recursive'\n", .{});
                std.debug.panic("Neither pre-built libraries nor vendor directory available for build");
            }
        }
    } else if (should_use_prebuilt and platform == null) {
        std.debug.print("⚠️  Platform {s}-{s} not supported for pre-built libraries\n", .{ @tagName(resolved_target.cpu.arch), @tagName(resolved_target.os.tag) });
        std.debug.print("   Supported platforms: linux-arm64, linux-x64, macos-arm64, macos-x64\n", .{});
        std.debug.print("   Checking for vendor directory fallback...\n", .{});

        if (checkVendorDirectoryExists(b)) {
            fallback_to_cargo = true;
            std.debug.print("✓ Found vendor directory, falling back to Cargo build\n", .{});
        } else {
            std.debug.panic("Platform not supported for pre-built libraries and no vendor directory available");
        }
    } else if (!should_use_prebuilt) {
        // Explicitly using cargo build
        if (checkVendorDirectoryExists(b)) {
            fallback_to_cargo = true;
            std.debug.print("✓ Using Cargo build (USE_PREBUILT_LIBS=false)\n");
        } else {
            std.debug.panic("Cargo build requested but vendor directory not available. Run 'git submodule update --init --recursive'");
        }
    }

    // Link appropriate libraries based on build strategy
    for (temporal_crates) |crate_info| {
        var archive: std.Build.LazyPath = undefined;

        if (use_prebuilt_libraries) {
            // Use pre-built static libraries
            archive = prebuiltArchivePath(b, version, platform.?, crate_info.archive);
            std.debug.print("  → Linking pre-built library: lib{s}.a\n", .{crate_info.archive});
        } else if (fallback_to_cargo) {
            // Use cargo-built libraries from vendor directory
            archive = cargoArchivePath(b, resolved_target, crate_info.archive);
            std.debug.print("  → Linking cargo-built library: lib{s}.a\n", .{crate_info.archive});

            // Add cargo build step as dependency
            const cargo_build = addCargoBuildStep(b, resolved_target);
            lib.step.dependOn(&cargo_build.step);
            unit_tests.step.dependOn(&cargo_build.step);
        } else {
            std.debug.panic("No valid build strategy determined");
        }

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
