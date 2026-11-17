/**
 * Structured errors shared by every Clasp package.
 *
 * Every failure that crosses a package boundary is a `ClaspError` with a
 * stable machine-readable `code`, so callers (the runtime, the Studio, the AI
 * repair loop) can branch on the kind of failure instead of parsing messages.
 */

export type ClaspErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "PERMISSION_DENIED"
  | "INVALID_OPERATION"
  | "CONFLICT"
  | "EXECUTION_LIMIT_EXCEEDED"
  | "STORAGE_FAILURE"
  | "UNAVAILABLE"
  | "INCOMPATIBLE"
  | "INTERNAL";

export type IssueSeverity = "error" | "warning";

/** One specific problem, usually part of a VALIDATION_FAILED error. */
export interface ClaspIssue {
  /** Stable issue identifier, e.g. `UNKNOWN_PORT`. */
  code: string;
  message: string;
  severity: IssueSeverity;
  /** Dotted path inside the offending value, when applicable. */
  path?: string;
  objectId?: string;
  connectionId?: string;
}

export interface ClaspErrorOptions {
  issues?: ClaspIssue[];
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class ClaspError extends Error {
  readonly code: ClaspErrorCode;
  readonly issues: ClaspIssue[];
  readonly details: Record<string, unknown>;

  constructor(code: ClaspErrorCode, message: string, options: ClaspErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ClaspError";
    this.code = code;
    this.issues = options.issues ?? [];
    this.details = options.details ?? {};
  }

  toJSON(): { code: ClaspErrorCode; message: string; issues: ClaspIssue[]; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, issues: this.issues, details: this.details };
  }
}

export function isClaspError(value: unknown): value is ClaspError {
  return value instanceof ClaspError;
}

/** Normalizes any thrown value into a ClaspError without losing the original. */
export function toClaspError(value: unknown, fallback: ClaspErrorCode = "INTERNAL"): ClaspError {
  if (value instanceof ClaspError) return value;
  if (value instanceof Error) return new ClaspError(fallback, value.message, { cause: value });
  return new ClaspError(fallback, String(value));
}

export function issue(
  code: string,
  message: string,
  extra: Partial<Omit<ClaspIssue, "code" | "message">> = {},
): ClaspIssue {
  return { code, message, severity: extra.severity ?? "error", ...extra };
}

export function hasErrors(issues: readonly ClaspIssue[]): boolean {
  return issues.some((entry) => entry.severity === "error");
}

/** Builds a VALIDATION_FAILED error summarizing the blocking issues. */
export function validationError(summary: string, issues: ClaspIssue[]): ClaspError {
  const blocking = issues.filter((entry) => entry.severity === "error");
  const first = blocking[0]?.message;
  const more = blocking.length > 1 ? ` (+${blocking.length - 1} more)` : "";
  return new ClaspError("VALIDATION_FAILED", first ? `${summary}: ${first}${more}` : summary, { issues });
}
