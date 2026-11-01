#!/bin/sh
# Builds the Fedora 44 image and its snapshot; see docs/sandboxing.md.
set -eu

exec "$(dirname "$0")/scripts/build.js" fedora-44
