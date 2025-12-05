# syntax=docker/dockerfile:1
FROM eclipse-temurin:21-jdk AS build
WORKDIR /workspace

COPY gradlew gradle.properties settings.gradle.kts build.gradle.kts ./
COPY gradle ./gradle
COPY platform ./platform
COPY websockets ./websockets
COPY technical-analysis ./technical-analysis

RUN chmod +x ./gradlew
RUN ./gradlew :websockets:installDist --no-daemon

FROM gcr.io/distroless/java21:nonroot
WORKDIR /app
COPY --from=build /workspace/websockets/build/install/websockets /app
ENTRYPOINT ["/app/bin/websockets"]
