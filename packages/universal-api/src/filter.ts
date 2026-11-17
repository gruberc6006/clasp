import { deepEqual, isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import type { FilterOperators, RecordFilter, SortSpec } from "./types";

const OPERATORS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$contains"]);

export function isOperatorObject(value: unknown): value is FilterOperators {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => OPERATORS.has(key));
}

function compare(a: JsonValue | undefined, b: JsonValue | undefined): number | undefined {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return undefined;
}

function contains(value: JsonValue | undefined, needle: string): boolean {
  if (typeof value === "string") return value.toLowerCase().includes(needle.toLowerCase());
  if (Array.isArray(value)) return value.some((entry) => deepEqual(entry, needle));
  return false;
}

/** Evaluates one condition against one value. Missing values equal `null`. */
export function matchesCondition(actual: JsonValue | undefined, condition: JsonValue | FilterOperators): boolean {
  const value = actual === undefined ? null : actual;
  if (!isOperatorObject(condition)) return deepEqual(value, condition);
  for (const [operator, operand] of Object.entries(condition) as Array<[keyof FilterOperators, JsonValue]>) {
    const order = compare(value, operand);
    switch (operator) {
      case "$eq":
        if (!deepEqual(value, operand)) return false;
        break;
      case "$ne":
        if (deepEqual(value, operand)) return false;
        break;
      case "$gt":
        if (order === undefined || !(order > 0)) return false;
        break;
      case "$gte":
        if (order === undefined || !(order >= 0)) return false;
        break;
      case "$lt":
        if (order === undefined || !(order < 0)) return false;
        break;
      case "$lte":
        if (order === undefined || !(order <= 0)) return false;
        break;
      case "$in":
        if (!Array.isArray(operand) || !operand.some((entry) => deepEqual(entry, value))) return false;
        break;
      case "$contains":
        if (typeof operand !== "string" || !contains(value, operand)) return false;
        break;
    }
  }
  return true;
}

/** True when `row` (a flat `{ id, ...fields }` object) satisfies every condition. */
export function matchesFilter(row: JsonObject, filter: RecordFilter | undefined): boolean {
  if (!filter) return true;
  for (const [field, condition] of Object.entries(filter)) {
    if (!matchesCondition(row[field], condition)) return false;
  }
  return true;
}

/** Stable multi-key sort over flat rows. Missing values sort last. */
export function sortRows<T extends JsonObject>(rows: readonly T[], sort: SortSpec | SortSpec[] | undefined): T[] {
  const specs = sort === undefined ? [] : Array.isArray(sort) ? sort : [sort];
  if (specs.length === 0) return [...rows];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      for (const spec of specs) {
        const left = a.row[spec.field];
        const right = b.row[spec.field];
        const leftMissing = left === undefined || left === null;
        const rightMissing = right === undefined || right === null;
        if (leftMissing && rightMissing) continue;
        if (leftMissing) return 1;
        if (rightMissing) return -1;
        const order = compare(left, right) ?? 0;
        if (order !== 0) return spec.direction === "desc" ? -order : order;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}
