#!/bin/bash
# Reconstruct source and build only. Never start the native helper.
set -euo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
app_root=$(cd -- "$script_dir/.." && pwd -P)
destination="$app_root/vendor/obsbot-mcp"
if (( $# )); then
  [[ $# == 2 && $1 == --destination && -n $2 ]] || fail 'Usage: install-obsbot-adapter.sh [--destination PATH]'
  destination=$2
fi
[[ $destination = /* ]] || destination="$PWD/$destination"
[[ ! -e $destination && ! -L $destination ]] || fail 'Bootstrap refuses to overwrite existing destination.'
[[ $(uname -s) == Linux ]] || fail 'This bootstrap requires Linux.'
for command in git node npm cmake; do
  command -v "$command" >/dev/null || fail "Required command unavailable: $command"
done
lock_values=$(node --input-type=module - "$app_root/vendor.lock.json" <<'JS'
import {readFileSync} from 'node:fs';
try {
  const lock = JSON.parse(readFileSync(process.argv[2],'utf8'));
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(lock.repository) || !/^[a-f0-9]{40}$/.test(lock.commit) || lock.hardening.patch !== 'patches/obsbot-mcp-hardening.patch') throw new Error();
  console.log(lock.repository); console.log(lock.commit); console.log(lock.hardening.patch);
} catch { console.error('Invalid public vendor lock.'); process.exit(1); }
JS
)
mapfile -t lock <<< "$lock_values"
[[ ${#lock[@]} == 3 ]] || fail 'Invalid public vendor lock.'
case $(uname -m) in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) fail 'Unsupported Linux architecture; helper path must match Node architecture.' ;;
esac
[[ $(node -p 'process.arch') == "$arch" ]] || fail 'Node architecture does not match native build.'
patch_path="$app_root/${lock[2]}"
[[ -f $patch_path ]] || fail 'Missing reviewed hardening patch.'
mkdir -p -- "$(dirname -- "$destination")"
# Atomically reserve the destination; never overwrite an existing partial build.
mkdir -- "$destination" || fail 'Bootstrap refuses to overwrite existing destination.'
git clone --no-checkout "${lock[0]}" "$destination"
git -C "$destination" checkout --detach "${lock[1]}"
[[ $(git -C "$destination" rev-parse HEAD) == "${lock[1]}" ]] || fail 'Vendor pin mismatch.'
git -C "$destination" apply --check "$patch_path"
git -C "$destination" apply "$patch_path"
git -C "$destination" apply --check "$app_root/patches/obsbot-mcp-linux.patch"
git -C "$destination" apply "$app_root/patches/obsbot-mcp-linux.patch"
git -C "$destination" apply --check "$app_root/patches/obsbot-mcp-dependencies.patch"
git -C "$destination" apply "$app_root/patches/obsbot-mcp-dependencies.patch"
cd -- "$destination"
npm ci
npm run build
npm test
cmake -S "$destination/native/linux" -B "$destination/native/linux/build" -DCMAKE_BUILD_TYPE=Release
cmake --build "$destination/native/linux/build"
mkdir -p -- "$destination/native/prebuilt/linux-$arch"
cp -- "$destination/native/linux/build/obsbot-helper" "$destination/native/prebuilt/linux-$arch/obsbot-helper"
sha256sum -- "$destination/native/prebuilt/linux-$arch/obsbot-helper"
printf 'Pinned Linux adapter reconstruction complete; helper was not run.\n'
