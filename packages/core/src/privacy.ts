const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const LOGIN_CONTEXT_PATTERN =
  /\b(login|log in|sign in|signin|account|credential|credentials|username|user id|email(?: address)?)\b/i;

const SECRET_ASSIGNMENT_PATTERNS = [
  /\b(password|passcode|passwd|secret|api(?: |_)?key|access(?: |_)?token|refresh(?: |_)?token|auth(?: |_)?token|bearer(?: |_)?token|private(?: |_)?key|ssh(?: |_)?key|session(?: |_)?cookie|cookie|otp|one(?: |-)?time(?: |-)?(?:password|passcode|code)|verification(?: |-)?code|recovery(?: |-)?code|backup(?: |-)?code|2fa(?: |-)?code|mfa(?: |-)?code|pin)\b(\s*(?:is|=|:)\s*)([^\s,;]+)/gi,
  /\b(username|user(?: |_)?name|email(?: address)?|login email|account email)\b(\s*(?:is|=|:)\s*)([^\s,;]+)/gi,
] as const;

const SECRET_TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
] as const;

export function redactSensitiveText(value: string): string {
  let redacted = value;

  for (const pattern of SECRET_ASSIGNMENT_PATTERNS) {
    redacted = redacted.replace(pattern, (_, label: string, separator: string) => {
      return `${label}${separator}[redacted]`;
    });
  }

  for (const pattern of SECRET_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }

  return redacted;
}

export function containsSensitiveCredentialContent(value: string): boolean {
  if (!value.trim()) {
    return false;
  }

  if (redactSensitiveText(value) !== value) {
    return true;
  }

  return EMAIL_PATTERN.test(value) && LOGIN_CONTEXT_PATTERN.test(value);
}
