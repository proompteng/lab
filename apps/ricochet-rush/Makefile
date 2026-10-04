PROJECT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BUILD_DIR ?= $(PROJECT_DIR)/build
GODOT ?= godot
GODOT_VERSION ?= 4.7.2.stable.official.ed1daf0bf
GDTOOLKIT_VERSION ?= 4.5.0
PYTHON ?= python3
GD_VENV ?= $(PROJECT_DIR)/.venv
GD_FORMAT ?= $(GD_VENV)/bin/gdformat
GD_LINT ?= $(GD_VENV)/bin/gdlint
TEST_SCRIPTS ?= tests/combat_test.gd tests/echo_test.gd tests/camera_test.gd tests/actor_visual_test.gd tests/game_test.gd
BLENDER ?= blender
ART_SCRIPT ?= tools/build_art.py

MACOS_OUTPUT ?= $(BUILD_DIR)/macos/RicochetRush.zip
WEB_OUTPUT ?= $(BUILD_DIR)/web/index.html

.DEFAULT_GOAL := check

.PHONY: all art check editor engine-version export-macos export-web format-check headless-import lint prepare-build run test tooling

all: check

check: headless-import format-check lint test

engine-version:
	@set -eu; \
	actual="$$("$(GODOT)" --version)"; \
	if [ "$$actual" != "$(GODOT_VERSION)" ]; then \
		echo "Godot version mismatch: expected $(GODOT_VERSION), got $$actual" >&2; \
		exit 1; \
	fi; \
	echo "Godot $$actual"

prepare-build:
	@mkdir -p "$(BUILD_DIR)" && : > "$(BUILD_DIR)/.gdignore"

run: engine-version prepare-build
	@"$(GODOT)" --path "$(PROJECT_DIR)"

editor: engine-version prepare-build
	@"$(GODOT)" --path "$(PROJECT_DIR)" --editor

headless-import: engine-version prepare-build
	@set -eu; \
	log="$$(mktemp)"; \
	trap 'rm -f "$$log"' EXIT; \
	set +e; \
	"$(GODOT)" --headless --path "$(PROJECT_DIR)" --editor --import >"$$log" 2>&1; \
	rc=$$?; \
	set -e; \
	cat "$$log"; \
	if [ "$$rc" -ne 0 ]; then \
		exit "$$rc"; \
	fi; \
	if grep -Eq 'SCRIPT ERROR:|ERROR:|Parse Error:' "$$log"; then \
		echo "Godot reported an error while importing the project" >&2; \
		exit 1; \
	fi

tooling:
	@set -eu; \
	if [ ! -x "$(GD_FORMAT)" ] || [ ! -x "$(GD_LINT)" ] || ! "$(GD_FORMAT)" --version 2>/dev/null | grep -Fqx "gdformat $(GDTOOLKIT_VERSION)" || ! "$(GD_LINT)" --version 2>/dev/null | grep -Fqx "gdlint $(GDTOOLKIT_VERSION)"; then \
		echo "Installing gdtoolkit $(GDTOOLKIT_VERSION) into $(GD_VENV)"; \
		"$(PYTHON)" -m venv "$(GD_VENV)"; \
		"$(GD_VENV)/bin/python" -m pip install --disable-pip-version-check --upgrade "gdtoolkit==$(GDTOOLKIT_VERSION)"; \
	fi

format-check: tooling
	@cd "$(PROJECT_DIR)" && "$(GD_FORMAT)" --check .

lint: tooling
	@cd "$(PROJECT_DIR)" && "$(GD_LINT)" .

test: headless-import
	@set -eu; \
	log="$$(mktemp)"; \
	trap 'rm -f "$$log"' EXIT; \
	for test_script in $(TEST_SCRIPTS); do \
		if [ ! -f "$(PROJECT_DIR)/$$test_script" ]; then \
			echo "Missing test script: $$test_script" >&2; \
			exit 1; \
		fi; \
		echo "Running $$test_script"; \
		set +e; \
		"$(GODOT)" --headless --fixed-fps 60 --path "$(PROJECT_DIR)" --script "$$test_script" >"$$log" 2>&1; \
		rc=$$?; \
		set -e; \
		cat "$$log"; \
		if [ "$$rc" -ne 0 ]; then \
			exit "$$rc"; \
		fi; \
		if grep -Eq 'SCRIPT ERROR:|ERROR:|Parse Error:' "$$log"; then \
			echo "Godot reported an error while running $$test_script" >&2; \
			exit 1; \
		fi; \
	done

export-macos: engine-version prepare-build
	@set -eu; \
	mkdir -p "$$(dirname "$(MACOS_OUTPUT)")"; \
	"$(GODOT)" --headless --path "$(PROJECT_DIR)" --export-release "macOS" "$(MACOS_OUTPUT)"; \
	test -s "$(MACOS_OUTPUT)"; \
	echo "macOS archive: $(MACOS_OUTPUT)"

export-web: engine-version prepare-build
	@set -eu; \
	mkdir -p "$$(dirname "$(WEB_OUTPUT)")"; \
	"$(GODOT)" --headless --path "$(PROJECT_DIR)" --export-release "Web" "$(WEB_OUTPUT)"; \
	test -s "$(WEB_OUTPUT)"; \
	echo "Web build: $(WEB_OUTPUT)"

art:
	@set -eu; \
	test -f "$(PROJECT_DIR)/$(ART_SCRIPT)"; \
	"$(BLENDER)" --background --factory-startup --python-exit-code 1 --python "$(PROJECT_DIR)/$(ART_SCRIPT)"
