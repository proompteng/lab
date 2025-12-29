# syntax=docker/dockerfile:1.6

FROM gradle:9.2-jdk25 as builder
WORKDIR /workspace
COPY --chown=gradle:gradle . .
RUN ./gradlew clean quarkusBuild --no-daemon

FROM gcr.io/distroless/java25:nonroot
WORKDIR /app
COPY --from=builder /workspace/build/quarkus-app /app/quarkus-app
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/quarkus-app/quarkus-run.jar"]
