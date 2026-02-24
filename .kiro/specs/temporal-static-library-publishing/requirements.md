# Requirements Document

## Introduction

This feature enables the building and publishing of pre-built static libraries from the Temporal Core SDK Rust C ABI as release artifacts on this repository. A GitHub Action using arm64 runners will build the static libraries and publish them as downloadable release artifacts. The system will then fetch and use these artifacts in the Zig bridge for the Bun runtime, eliminating the current 15-minute build process.

## Glossary

- **Temporal_Core_SDK**: The Rust implementation of Temporal's core SDK that provides C ABI bindings
- **Static_Library**: A compiled library file (.a on Unix, .lib on Windows) containing object code from the C bridge
- **GitHub_Action**: An automated workflow that builds and publishes static libraries using arm64 runners
- **Release_Artifact**: A downloadable file attached to a GitHub release containing pre-built static libraries
- **Zig_Bridge**: The Zig-based bridge that interfaces between Bun runtime and Temporal Core SDK
- **Download_Client**: A component that fetches appropriate static libraries from this repository's releases
- **ARM64_Runner**: A GitHub Actions runner using arm64 architecture from the cluster resources

## Requirements

### Requirement 1

**User Story:** As a developer using the Temporal Bun SDK, I want pre-built static libraries to be automatically downloaded during the build process, so that I don't have to wait 15 minutes for Rust compilation.

#### Acceptance Criteria

1. WHEN the build process starts, THE Download_Client SHALL fetch the appropriate static library for the current platform and architecture
2. THE Static_Library SHALL be compatible with the Zig_Bridge compilation process
3. THE download process SHALL complete in under 30 seconds for typical network conditions
4. IF the static library download fails, THEN THE system SHALL fall back to local Rust compilation
5. THE Static_Library SHALL maintain the same C ABI interface as the locally compiled version

### Requirement 2

**User Story:** As a maintainer of the Temporal Bun SDK, I want a GitHub Action to automatically build and publish static libraries for multiple platforms, so that users can benefit from faster build times.

#### Acceptance Criteria

1. THE GitHub_Action SHALL build static libraries for Linux ARM64, Linux x64, and macOS ARM64 platforms
2. THE GitHub_Action SHALL use ARM64_Runner tags to utilize cluster resources
3. WHEN triggered, THE GitHub_Action SHALL compile the Temporal Core SDK C ABI into static libraries
4. THE GitHub_Action SHALL publish compiled libraries as Release_Artifact attachments
5. THE GitHub_Action SHALL support manual triggering via workflow_dispatch and successfully publish new release artifacts

### Requirement 3

**User Story:** As a CI/CD system building the Temporal Bun SDK, I want to reliably access static libraries from this repository's GitHub releases, so that automated builds can complete successfully.

#### Acceptance Criteria

1. THE Download_Client SHALL access static libraries from this repository's GitHub releases
2. THE Download_Client SHALL support HTTPS protocol for library retrieval from GitHub releases API
3. THE system SHALL verify checksums provided with Release_Artifact for integrity verification
4. THE Download_Client SHALL handle GitHub API rate limits gracefully
5. WHERE network connectivity is limited, THE Download_Client SHALL support resume capabilities for interrupted downloads

### Requirement 4

**User Story:** As a developer working offline or in restricted networks, I want the ability to cache static libraries locally, so that I can build the SDK without internet access.

#### Acceptance Criteria

1. THE Download_Client SHALL cache downloaded static libraries in a local directory
2. THE system SHALL verify cached library integrity before use
3. WHERE a valid cached library exists, THE Download_Client SHALL use the cached version instead of downloading
4. THE cache SHALL support manual clearing and updating of stored libraries
5. THE system SHALL provide clear error messages when neither cached nor downloaded libraries are available

### Requirement 5

**User Story:** As a maintainer, I want to manually trigger the static library build process, so that I can publish new release artifacts on demand.

#### Acceptance Criteria

1. THE GitHub_Action SHALL provide a workflow_dispatch trigger for manual execution
2. WHEN manually triggered, THE GitHub_Action SHALL successfully build all target platform libraries
3. THE GitHub_Action SHALL create a new GitHub release with version tagging
4. THE GitHub_Action SHALL attach all built static libraries as Release_Artifact to the new release
5. THE GitHub_Action SHALL provide clear success/failure feedback in the workflow logs

### Requirement 6

**User Story:** As a developer using the Codex image, I want the Rust bootstrap, installation, and compilation steps to be removed and replaced with binary downloads, so that image builds are faster and more reliable.

#### Acceptance Criteria

1. THE Codex image build process SHALL remove all Rust toolchain installation steps
2. THE Codex image build process SHALL remove all Cargo compilation steps
3. THE Codex image build process SHALL download and use pre-built static libraries instead
4. THE Codex image SHALL maintain the same functionality as before but with faster build times
5. THE Codex image build process SHALL fail gracefully if pre-built libraries are unavailable

### Requirement 7

**User Story:** As a CI/CD maintainer, I want all CI jobs to be updated to use pre-built binaries instead of Cargo installation and compilation, so that CI runs are faster and consume fewer resources.

#### Acceptance Criteria

1. THE CI jobs SHALL remove all Cargo installation steps
2. THE CI jobs SHALL remove all Cargo compilation steps for temporal-sdk-core
3. THE CI jobs SHALL download and use pre-built static libraries from Release_Artifact
4. THE CI jobs SHALL maintain the same test coverage and functionality
5. THE CI jobs SHALL complete in significantly less time than the current 15-minute build process

### Requirement 8

**User Story:** As a maintainer, I want all other locations in the codebase that perform Rust compilation to be identified and updated, so that the entire system uses pre-built binaries consistently.

#### Acceptance Criteria

1. THE system SHALL scan all Dockerfiles, CI configurations, and build scripts for Rust compilation steps
2. THE system SHALL identify all locations that install Rust toolchain or perform Cargo builds
3. THE system SHALL update identified locations to use pre-built static libraries
4. THE system SHALL document all changes made to existing build processes
5. THE system SHALL ensure no build process falls back to Rust compilation unless explicitly configured

### Requirement 9

**User Story:** As a security-conscious developer, I want static libraries to be verified against published checksums, so that I can trust the integrity of the downloaded artifacts.

#### Acceptance Criteria

1. THE GitHub_Action SHALL generate checksums for all built static libraries
2. THE Download_Client SHALL verify downloaded libraries against checksums provided in Release_Artifact
3. IF checksum verification fails, THEN THE Download_Client SHALL reject the library and attempt fallback compilation
4. THE system SHALL provide clear error messages when verification fails
5. THE Download_Client SHALL validate that downloaded libraries match the expected file format and architecture
