BUILDER_IMAGE_NAME = baozi
TEST_APP_IMAGE_NAME = baozi-test-app
TEST_APP_CONTAINER_NAME = $(TEST_APP_IMAGE_NAME)-container
S2I_CMD ?= s2i # Allows overriding the s2i command path if needed
REGISTRY_URL = registry.ide-newton.ts.net/lab
IMAGE_TAG ?= latest
FULL_BUILDER_IMAGE_NAME = $(REGISTRY_URL)/$(BUILDER_IMAGE_NAME):$(IMAGE_TAG)

.PHONY: all
all: test

.PHONY: build
build:
	@echo "---> Building S2I builder image: $(BUILDER_IMAGE_NAME)"
	docker build -t $(BUILDER_IMAGE_NAME) .

.PHONY: push
push: build
	@echo "---> Tagging image $(BUILDER_IMAGE_NAME) as $(FULL_BUILDER_IMAGE_NAME)"
	docker tag $(BUILDER_IMAGE_NAME) $(FULL_BUILDER_IMAGE_NAME)
	@echo "---> Pushing image $(FULL_BUILDER_IMAGE_NAME) to registry"
	docker push $(FULL_BUILDER_IMAGE_NAME)

.PHONY: test
test: build
	@echo "---> Building test application image: $(TEST_APP_IMAGE_NAME) using S2I"
	$(S2I_CMD) build test/test-app $(BUILDER_IMAGE_NAME) $(TEST_APP_IMAGE_NAME)

.PHONY: run
run: test
	@echo "---> Running test application container: $(TEST_APP_CONTAINER_NAME)"
	-docker rm -f $(TEST_APP_CONTAINER_NAME) > /dev/null 2>&1 || true
	docker run -d -p 3000:3000 --name $(TEST_APP_CONTAINER_NAME) $(TEST_APP_IMAGE_NAME)
	@echo "Container running. Access at http://localhost:3000"

.PHONY: verify
verify: run
	@echo "Waiting for container to start... (1s)"
	@sleep 1
	@echo "---> Verifying application endpoint (http://localhost:3000)"
	@curl -sf http://localhost:3000 | grep -q "Hello from Bun S2I!" || (echo "Verification failed!" && exit 1)
	@echo "Verification successful!"

.PHONY: stop
stop:
	@echo "---> Stopping and removing container: $(TEST_APP_CONTAINER_NAME)"
	-docker stop $(TEST_APP_CONTAINER_NAME) > /dev/null 2>&1
	-docker rm $(TEST_APP_CONTAINER_NAME) > /dev/null 2>&1

.PHONY: clean
clean: stop
	@echo "---> Removing images: $(TEST_APP_IMAGE_NAME), $(BUILDER_IMAGE_NAME)"
	-docker rmi $(TEST_APP_IMAGE_NAME) > /dev/null 2>&1 || true
	-docker rmi $(BUILDER_IMAGE_NAME) > /dev/null 2>&1 || true

.PHONY: default
default: build
