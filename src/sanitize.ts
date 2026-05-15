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
