import { getPath, isJsonObject, type JsonObject, type JsonValue, type PortSpec } from "@clasp/core";
import type { ComponentContext, ComponentInstance } from "@clasp/runtime";
import { matchesCondition } from "@clasp/universal-api";

export const VISIBLE: PortSpec = { name: "visible", type: "boolean", description: "The element is hidden while this is false." };

export const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "truthy", "falsy"] as const;
export type Operator = (typeof OPERATORS)[number];

/** Rows flowing between data components: plain objects carrying an `id`. */
export function asRows(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

export function asText(value: JsonValue | undefined, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export function asNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function isTruthy(value: JsonValue | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

export function isBlank(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** Applies a comparison operator. Unary operators ignore `expected`. */
export function test(operator: string, actual: JsonValue | undefined, expected: JsonValue | undefined): boolean {
  const right = expected === undefined ? null : expected;
  switch (operator as Operator) {
    case "eq":
      return matchesCondition(actual, right);
    case "neq":
      return !matchesCondition(actual, right);
    case "gt":
      return matchesCondition(actual, { $gt: right as number });
    case "gte":
      return matchesCondition(actual, { $gte: right as number });
    case "lt":
      return matchesCondition(actual, { $lt: right as number });
    case "lte":
      return matchesCondition(actual, { $lte: right as number });
    case "contains":
      return matchesCondition(actual, { $contains: asText(right) });
    case "truthy":
      return isTruthy(actual);
    case "falsy":
      return !isTruthy(actual);
    default:
      return false;
  }
}

export function isUnary(operator: string): boolean {
  return operator === "truthy" || operator === "falsy";
}

/**
 * Fills `{name}` placeholders from a scope. `{value}` refers to the scope
 * itself when it is not an object. Unknown placeholders become empty text.
 * This is plain substitution — nothing is evaluated.
 */
export function fillTemplate(text: string, scope: JsonValue | undefined): string {
  return text.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_match, key: string) => {
    if (isJsonObject(scope)) {
      const found = getPath(scope, key);
      if (found !== undefined && found !== null) return typeof found === "object" ? JSON.stringify(found) : String(found);
      return "";
    }
    if (key === "value" && scope !== undefined && scope !== null) return typeof scope === "object" ? JSON.stringify(scope) : String(scope);
    return "";
  });
}

/** A component whose outputs are a pure function of its inputs and properties. */
export function pure(compute: (ctx: ComponentContext) => void): (ctx: ComponentContext) => ComponentInstance {
  return (ctx) => {
    compute(ctx);
    return { onInput: () => compute(ctx) };
  };
}
