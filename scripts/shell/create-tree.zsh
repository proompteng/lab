#!/usr/bin/env zsh
# Generate directory tree structure for documentation

tree -I 'node_modules|.git|.turbo|.next|dist|build|target|*.log|.pnpm-store' --dirsfirst -a
