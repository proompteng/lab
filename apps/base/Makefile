IMAGE_NAME = base
REGISTRY_URL = registry.ide-newton.ts.net/lab
IMAGE_TAG ?= latest
FULL_BUILDER_IMAGE_NAME = $(REGISTRY_URL)/$(IMAGE_NAME):$(IMAGE_TAG)

.PHONY: build
build:
	docker build -t $(IMAGE_NAME) .

.PHONY: test
test:
	docker build -t $(IMAGE_NAME)-candidate .
	IMAGE_NAME=$(IMAGE_NAME)-candidate test/run

.PHONY: push
push: build
	@echo "---> Tagging image $(IMAGE_NAME) as $(FULL_BUILDER_IMAGE_NAME)"
	docker tag $(IMAGE_NAME) $(FULL_BUILDER_IMAGE_NAME)
	@echo "---> Pushing image $(FULL_BUILDER_IMAGE_NAME) to registry"
	docker push $(FULL_BUILDER_IMAGE_NAME)
