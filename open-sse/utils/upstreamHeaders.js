const FORWARDED = new Set([
  "retry-after",
  "x-should-retry",
  // Groq rate-limit hints (TPM/RPM resets). Forwarded so combo/account
  // fallback can honor retry-after / reset instead of retrying blindly.
  "x-ratelimit-reset-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-limit-requests",
  "ratelimit-reset",
  "ratelimit-remaining",
]);
const FORWARDED_PREFIX = "anthropic-ratelimit-";

export function upstreamResponseHeaders(headers) {
  const out = {};
  if (typeof headers?.forEach !== "function") return out;
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (FORWARDED.has(key) || key.startsWith(FORWARDED_PREFIX)) out[key] = value;
  });
  return out;
}
