#!/bin/sh
set -eu
vendor=${1:?usage: test/native-snapshot.sh VENDOR_PATH OUTPUT_DIR}
out=${2:?explicit OUTPUT_DIR required}
mkdir -p "$out"
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
gcc -std=c11 -g -Wall -Wextra ${NATIVE_CFLAGS:-} -DHELPER_SOURCE=\"$(realpath "$vendor/native/linux/helper.c")\" "$root/native-fixtures/snapshot.c" -ljpeg -lm -o "$out/snapshot-fixture"
"$out/snapshot-fixture"
