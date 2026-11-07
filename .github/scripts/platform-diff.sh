#!/usr/bin/env bash
# kubectl diff's external diff program for the platform plan (KUBECTL_EXTERNAL_DIFF, O-105).
# kubectl calls it with two folders, the live objects and the objects as they would be after the
# apply, one file per object named <group.>version.Kind.namespace.name. It prints one line per
# object that would be created or changed, and none of any object's content, so no field of a
# live object reaches the public log. Exit 1 means differences and 0 none, as kubectl expects.
set -euo pipefail
live="${1:?}"
merged="${2:?}"
differs=0
for file in "$merged"/*; do
  [ -e "$file" ] || continue
  name="${file##*/}"
  if [ ! -s "$live/$name" ]; then
    echo "create $name"
    differs=1
  elif ! cmp --silent "$live/$name" "$file"; then
    echo "update $name"
    differs=1
  fi
done
exit "$differs"
