# syntax=docker/dockerfile:1.6

FROM ghcr.io/ziglang/zig:0.15.1 as builder
WORKDIR /workspace
COPY build.zig build.zig
COPY build.zig.zon build.zig.zon
COPY src src
RUN zig build -Doptimize=ReleaseFast

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=builder /workspace/zig-out/bin/galette ./galette
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/galette"]
