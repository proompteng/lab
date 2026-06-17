# syntax=docker/dockerfile:1
FROM mirror.gcr.io/eclipse-temurin:21-jdk AS build
WORKDIR /workspace

COPY gradlew gradle.properties settings.gradle.kts build.gradle.kts ./
COPY gradle ./gradle
COPY platform ./platform
COPY flink-integration ./flink-integration
COPY websockets ./websockets
COPY technical-analysis ./technical-analysis
COPY technical-analysis-flink ./technical-analysis-flink
COPY hyperliquid-feed ./hyperliquid-feed

RUN chmod +x ./gradlew
RUN ./gradlew :hyperliquid-feed:installDist --no-daemon

FROM gcr.io/distroless/java25:nonroot
WORKDIR /app
COPY --from=build /workspace/hyperliquid-feed/build/install/hyperliquid-feed /app
ENTRYPOINT ["/usr/bin/java", "-cp", "/app/lib/*", "ai.proompteng.dorvud.hyperliquid.HyperliquidFeedAppKt"]
