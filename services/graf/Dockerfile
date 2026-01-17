# syntax=docker/dockerfile:1.6

FROM gradle:9.2-jdk25 as builder
WORKDIR /workspace
ARG GRAF_GRADLE_TASKS="quarkusBuild"
ARG GRAF_GRADLE_ARGS="--no-daemon --build-cache"
ENV GRADLE_USER_HOME=/home/gradle/.gradle
COPY --chown=gradle:gradle . .
RUN --mount=type=cache,target=/home/gradle/.gradle \
  --mount=type=cache,target=/workspace/.gradle \
  /bin/bash -lc "./gradlew ${GRAF_GRADLE_TASKS} ${GRAF_GRADLE_ARGS}"

FROM gcr.io/distroless/java25:nonroot
WORKDIR /app
COPY --from=builder /workspace/build/quarkus-app /app/quarkus-app
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/quarkus-app/quarkus-run.jar"]
