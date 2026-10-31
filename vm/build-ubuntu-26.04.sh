#!/bin/sh
# Builds the Ubuntu 26.04 image and its snapshot; see docs/sandboxing.md.
set -eu

exec "$(dirname "$0")/scripts/build.js" ubuntu-26.04
