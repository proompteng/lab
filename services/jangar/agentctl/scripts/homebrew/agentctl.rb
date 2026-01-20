class Agentctl < Formula
  desc "gRPC CLI for managing agents through Jangar"
  homepage "https://github.com/proompteng/lab/tree/main/services/jangar/agentctl"
  version "__VERSION__"

  on_macos do
    on_arm do
      url "https://github.com/proompteng/lab/releases/download/v#{version}/agentctl-#{version}-darwin-arm64.tar.gz"
      sha256 "__SHA256_DARWIN_ARM64__"
    end
    on_intel do
      url "https://github.com/proompteng/lab/releases/download/v#{version}/agentctl-#{version}-darwin-amd64.tar.gz"
      sha256 "__SHA256_DARWIN_AMD64__"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/proompteng/lab/releases/download/v#{version}/agentctl-#{version}-linux-arm64.tar.gz"
      sha256 "__SHA256_LINUX_ARM64__"
    end
    on_intel do
      url "https://github.com/proompteng/lab/releases/download/v#{version}/agentctl-#{version}-linux-amd64.tar.gz"
      sha256 "__SHA256_LINUX_AMD64__"
    end
  end

  def install
    bin.install "agentctl"
  end

  test do
    system bin/"agentctl", "--help"
  end
end
