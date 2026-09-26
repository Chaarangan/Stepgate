import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

/** `sha256:` plus the hex digest of the RFC 8785 canonical JSON form. */
export function canonicalHash(value: unknown): string {
  const canonical = canonicalize(value);
  if (canonical === undefined) {
    throw new TypeError(`value of type ${typeof value} has no canonical JSON form`);
  }
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function textHash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
