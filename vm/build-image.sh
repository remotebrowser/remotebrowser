#!/bin/sh
# Builds the Debian 13 image and snapshot.
set -eu

dir=$(dirname "$0")

"$dir/build-debian-13.sh" &
debian=$!

status=0
wait "$debian" || status=1
exit "$status"
