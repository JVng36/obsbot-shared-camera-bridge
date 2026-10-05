#!/bin/bash
set -euo pipefail
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ -t 0 && -t 1 && -t 2 ]] || fail 'Start requires a visible terminal.'
(( EUID != 0 )) || fail 'Start requires a nonroot operator.'
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
app_root=$(cd -- "$script_dir/.." && pwd -P)
config="$app_root/config/secrets.json"
vendor_root="$app_root/vendor/obsbot-mcp"
selected_node=''
minutes=30
while (( $# )); do
  (( $# >= 2 )) || fail 'Every option requires a value.'
  case "$1" in
    --config) config=$2 ;;
    --vendor-root) vendor_root=$2 ;;
    --node) selected_node=$2 ;;
    --minutes) minutes=$2 ;;
    *) fail 'Unknown launcher option.' ;;
  esac
  shift 2
done
[[ $minutes =~ ^[0-9]{1,5}$ ]] || fail 'minutes must be an integer from 1 through 10080.'
minutes=$((10#$minutes))
(( minutes >= 1 && minutes <= 10080 )) || fail 'minutes must be an integer from 1 through 10080.'
if [[ -z $selected_node ]]; then
  selected_node=$(command -v node) || fail 'Node is required.'
fi
[[ $config = /* ]] || config="$PWD/$config"
[[ $vendor_root = /* ]] || vendor_root="$PWD/$vendor_root"
[[ $selected_node = /* ]] || selected_node="$PWD/$selected_node"
[[ -x $selected_node ]] || fail 'Selected Node path is not executable.'
# Stable across config paths and app installations. Never remove this lock file.
# A private directory beneath sticky /tmp prevents other users replacing it.
umask 077
lock_dir="/tmp/obsbot-shared-camera-$EUID"
if [[ ! -e $lock_dir && ! -L $lock_dir ]]; then
  mkdir -- "$lock_dir" 2>/dev/null || true
fi
[[ -d $lock_dir && ! -L $lock_dir ]] || fail 'Unsafe hardware owner lock directory.'
[[ $(stat -c '%u:%a' -- "$lock_dir") == "$EUID:700" ]] || fail 'Unsafe hardware owner lock directory.'
lock_file="$lock_dir/owner.lock"
if [[ ! -e $lock_file && ! -L $lock_file ]]; then
  (set -o noclobber; : > "$lock_file") 2>/dev/null || true
fi
[[ -f $lock_file && ! -L $lock_file ]] || fail 'Unsafe hardware owner lock file.'
[[ $(stat -c '%u:%a:%h' -- "$lock_file") == "$EUID:600:1" ]] || fail 'Unsafe hardware owner lock file.'
exec 9< "$lock_file"
[[ $(stat -Lc '%d:%i' -- /proc/self/fd/9) == $(stat -c '%d:%i' -- "$lock_file") ]] || fail 'Hardware owner lock changed.'
flock -n 9 || fail 'Shared camera already has an owner; start refused.'
printf 'Start shared camera for %s minutes. Type START to confirm: ' "$minutes"
IFS= read -r confirmation || fail 'Start cancelled.'
[[ $confirmation == START ]] || fail 'Start cancelled.'
# Sanitize at the Node boundary: JavaScript preflight would be too late.
# The invoking shell, PATH utilities and selected executable must be trusted.
unset NODE_OPTIONS NODE_PATH NODE_USE_ENV_PROXY \
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy \
  node_options node_path node_use_env_proxy \
  LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT ld_preload ld_library_path ld_audit \
  NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_REDIRECT_WARNINGS \
  NODE_DIAGNOSTIC_DIR NODE_REPORT_DIRECTORY NODE_REPORT_FILENAME SSLKEYLOGFILE \
  OPENSSL_CONF OPENSSL_MODULES NODE_EXTRA_CA_CERTS openssl_conf openssl_modules node_extra_ca_certs \
  node_v8_coverage node_compile_cache node_redirect_warnings \
  node_diagnostic_dir node_report_directory node_report_filename sslkeylogfile
ulimit -c 0 || fail 'Cannot disable core dumps.'
exec "$selected_node" "$app_root/src/linux-entry.js" --config "$config" --vendor-root "$vendor_root" --minutes "$minutes"
