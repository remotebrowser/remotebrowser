#!/bin/sh
# Builds the image and snapshot of each guest OS, all at once.
set -eu

dir=$(dirname "$0")

"$dir/build-debian-13.sh" &
debian=$!
"$dir/build-ubuntu-26.04.sh" &
ubuntu=$!

status=0
wait "$debian" || status=1
wait "$ubuntu" || status=1
exit "$status"
