const URI_REFERENCE = /(?:^|[\s"'`(])(?:data|blob|file|https?|ftp|cid|media)\s*:/i;
const NETWORK_PATH = /(?:^|[\s"'`(])(?:\\\\|\/\/)[^\s\\/"'`]+[\\/][^\s"'`]+/;
const ABSOLUTE_PATH = /(?:^|[\s"'`(])(?:[A-Za-z]:[\\/]|\/(?!\/))(?:[^\s\\/"'`]+[\\/])+[^\s"'`]+/;
const DOT_RELATIVE_PATH = /(?:^|[\s"'`(])\.{1,2}[\\/](?:[^\s\\/"'`]+[\\/])*[^\s"'`]+/;
const LONG_BASE64_RUN = /[A-Za-z0-9+/_-]{256,}={0,2}/;
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export function isSafeObservationText(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 2_000
    && !URI_REFERENCE.test(value)
    && !NETWORK_PATH.test(value)
    && !ABSOLUTE_PATH.test(value)
    && !DOT_RELATIVE_PATH.test(value)
    && !LONG_BASE64_RUN.test(value)
    && !DISALLOWED_CONTROL.test(value);
}
