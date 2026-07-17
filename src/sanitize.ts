// E.164-ish phone match: optional `+`, 7–15 digits with optional separators.
const PHONE_PATTERN = /\+?\d[\d\s()\-.]{6,18}\d/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Mask a phone number, keeping the leading `+` (if any) plus the first 3 digits
 * and the last 4 digits visible. Example: `+13315553374` -> `+133xxxxx3374`.
 *
 * Inputs that don't have enough digits to safely mask are returned as
 * `xxxx` to avoid leaking the entire short value.
 */
export function sanitizePhone(input: string): string {
  const hasPlus = input.startsWith("+");
  const digits = input.replace(/\D/g, "");
  if (digits.length < 8) {
    return hasPlus ? "+xxxx" : "xxxx";
  }
  const head = digits.slice(0, 3);
  const tail = digits.slice(-4);
  const middleLength = digits.length - head.length - tail.length;
  return `${hasPlus ? "+" : ""}${head}${"x".repeat(middleLength)}${tail}`;
}

/**
 * Mask an email address, keeping the first 2 chars of the local part, the
 * first char of the domain, and the TLD. Example:
 * `foo.bar@example.com` -> `fo***@e***.com`.
 */
export function sanitizeEmail(input: string): string {
  const atIndex = input.lastIndexOf("@");
  if (atIndex < 1) {
    return "***";
  }
  const local = input.slice(0, atIndex);
  const domain = input.slice(atIndex + 1);
  const dotIndex = domain.lastIndexOf(".");
  if (dotIndex < 1) {
    return "***";
  }
  const localHead = local.slice(0, 2);
  const domainHead = domain.slice(0, 1);
  const tld = domain.slice(dotIndex);
  return `${localHead}***@${domainHead}***${tld}`;
}

/**
 * Replace every phone number and email address inside a free-form string with
 * its sanitized form. Used to scrub `Error.message` values before attaching
 * them to span status.
 */
export function sanitizeErrorMessage(input: string): string {
  return input
    .replace(EMAIL_PATTERN, (match) => sanitizeEmail(match))
    .replace(PHONE_PATTERN, (match) => sanitizePhone(match));
}

/** The literal placeholder OTel uses for redacted URL values. */
const REDACTED = "REDACTED";

/**
 * Query-parameter names the OpenTelemetry URL semantic conventions redact by
 * default. Matching is case-sensitive, per the spec.
 * @see https://opentelemetry.io/docs/specs/semconv/url/url/
 */
const DEFAULT_SENSITIVE_PARAMS = [
  "X-Amz-Signature",
  "X-Amz-Credential",
  "X-Amz-Security-Token",
  "sig",
  "X-Goog-Signature",
];

export interface SanitizeUrlOptions {
  /**
   * Additional query-parameter names whose values are redacted, on top of the
   * built-in list. Case-sensitive, matching the OTel semantic conventions.
   */
  params?: string[];
  /**
   * Redact the built-in semconv sensitive-parameter list and userinfo
   * credentials (`user:pass@host`). Defaults to `true`; set `false` to redact
   * only the names passed in `params`.
   */
  redactDefaults?: boolean;
}

/** Mask `user:pass@` credentials in place. Returns whether anything changed. */
function redactUserinfo(parsed: URL): boolean {
  let changed = false;
  if (parsed.username) {
    parsed.username = REDACTED;
    changed = true;
  }
  if (parsed.password) {
    parsed.password = REDACTED;
    changed = true;
  }
  return changed;
}

/**
 * Replace the value of each present sensitive query parameter with `REDACTED`,
 * keeping the key. Returns whether anything changed.
 */
function redactQueryParams(parsed: URL, keys: Set<string>): boolean {
  let changed = false;
  for (const key of keys) {
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  return changed;
}

/**
 * Redact secrets from a URL before it is recorded as a span attribute,
 * following the OpenTelemetry URL semantic conventions: sensitive
 * query-parameter values and `user:pass@` credentials are replaced with the
 * literal `REDACTED`, with the parameter key preserved (`sig=REDACTED`).
 * Non-sensitive parameters and the path are left intact.
 *
 * Built to pair with the `redactUrl` fetch option, e.g.
 * `createInstrumentedFetch(undefined, { redactUrl: (u) => sanitizeUrl(u, { params: ["token"] }) })`.
 *
 * Unparseable input — and input with nothing to redact — is returned unchanged
 * (no query-string re-encoding when no secret matched).
 */
export function sanitizeUrl(url: string, options?: SanitizeUrlOptions): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const redactDefaults = options?.redactDefaults !== false;
  const keys = new Set<string>([
    ...(redactDefaults ? DEFAULT_SENSITIVE_PARAMS : []),
    ...(options?.params ?? []),
  ]);
  const userinfoChanged = redactDefaults && redactUserinfo(parsed);
  const paramsChanged = redactQueryParams(parsed, keys);
  return userinfoChanged || paramsChanged ? parsed.toString() : url;
}
