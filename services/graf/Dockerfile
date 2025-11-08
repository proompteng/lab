# syntax=docker/dockerfile:1.6

FROM gradle:8.5-jdk21 as builder
WORKDIR /workspace
COPY --chown=gradle:gradle . .
RUN ./gradlew clean installDist --no-daemon

FROM gcr.io/distroless/java21-debian12:nonroot
WORKDIR /app
COPY --from=builder /workspace/build/install/graf /app
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/app/bin/graf"]
