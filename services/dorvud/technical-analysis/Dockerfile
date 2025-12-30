# syntax=docker/dockerfile:1
FROM eclipse-temurin:21-jdk AS build
WORKDIR /workspace

COPY gradlew gradle.properties settings.gradle.kts build.gradle.kts ./
COPY gradle ./gradle
COPY platform ./platform
COPY flink-integration ./flink-integration
COPY technical-analysis ./technical-analysis
COPY technical-analysis-flink ./technical-analysis-flink
COPY websockets ./websockets

RUN chmod +x ./gradlew
RUN ./gradlew :technical-analysis:shadowJar --no-daemon

FROM gcr.io/distroless/java25:nonroot
WORKDIR /app
COPY --from=build /workspace/technical-analysis/build/libs/*-all.jar /app/technical-analysis.jar
ENTRYPOINT ["/usr/bin/java", "-jar", "/app/technical-analysis.jar"]
