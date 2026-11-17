/**
 * A small, safe spreadsheet formula language.
 *
 * Formulas are parsed into a tree and evaluated by this module — never by
 * `eval` or `new Function`. Supported: numbers, "text", TRUE/FALSE, cell
 * references (A1), ranges (A1:B3), + - * / ^ & = <> < > <= >=, parentheses,
 * and the functions listed in FUNCTIONS.
 */

export type CellValue = number | string | boolean | null | CellError;

export class CellError {
  constructor(
    readonly code: "#REF!" | "#DIV/0!" | "#NAME?" | "#VALUE!" | "#CYCLE!" | "#ERROR!",
    readonly detail = "",
  ) {}

  toString(): string {
    return this.code;
  }
}

type Node =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "ref"; ref: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "unary"; op: "-" | "+"; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

// ── addresses ────────────────────────────────────────────────────────────

export function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function parseAddress(ref: string): { column: number; row: number } | undefined {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,5})$/.exec(ref.toUpperCase());
  if (!match) return undefined;
  let column = 0;
  for (const char of match[1] as string) column = column * 26 + (char.charCodeAt(0) - 64);
  return { column: column - 1, row: Number(match[2]) - 1 };
}

export function address(column: number, row: number): string {
  return `${columnName(column)}${row + 1}`;
}

function rangeCells(from: string, to: string): string[] | undefined {
  const a = parseAddress(from);
  const b = parseAddress(to);
  if (!a || !b) return undefined;
  const cells: string[] = [];
  for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) {
    for (let column = Math.min(a.column, b.column); column <= Math.max(a.column, b.column); column++) cells.push(address(column, row));
  }
  return cells.length > 10_000 ? undefined : cells;
}

// ── parsing ──────────────────────────────────────────────────────────────

type Token = { type: "num" | "str" | "id" | "op" | "(" | ")" | "," | ":"; text: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|^[0-9]+\.?/.exec(source.slice(i));
      if (!match) throw new CellError("#ERROR!", "bad number");
      tokens.push({ type: "num", text: match[0] });
      i += match[0].length;
      continue;
    }
    if (char === '"') {
      let end = i + 1;
      let text = "";
      while (end < source.length && source[end] !== '"') text += source[end++];
      if (end >= source.length) throw new CellError("#ERROR!", "unterminated text");
      tokens.push({ type: "str", text });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(i)) as RegExpExecArray;
      tokens.push({ type: "id", text: match[0] });
      i += match[0].length;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") {
      tokens.push({ type: "op", text: two });
      i += 2;
      continue;
    }
    if ("+-*/^&=<>".includes(char)) {
      tokens.push({ type: "op", text: char });
      i++;
      continue;
    }
    if (char === "(" || char === ")" || char === "," || char === ":") {
      tokens.push({ type: char, text: char });
      i++;
      continue;
    }
    throw new CellError("#ERROR!", `unexpected "${char}"`);
  }
  return tokens;
}

const PRECEDENCE: Record<string, number> = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

export function parseFormula(source: string): Node {
  const tokens = tokenize(source);
  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const take = (): Token => {
    const token = tokens[position++];
    if (!token) throw new CellError("#ERROR!", "formula ends too early");
    return token;
  };

  const primary = (): Node => {
    const token = take();
    switch (token.type) {
      case "num":
        return { kind: "number", value: Number(token.text) };
      case "str":
        return { kind: "string", value: token.text };
      case "(": {
        const inner = expression(0);
        if (take().type !== ")") throw new CellError("#ERROR!", "missing )");
        return inner;
      }
      case "op":
        if (token.text === "-" || token.text === "+") return { kind: "unary", op: token.text, operand: expression(5) };
        throw new CellError("#ERROR!", `unexpected ${token.text}`);
      case "id": {
        const upper = token.text.toUpperCase();
        if (peek()?.type === "(") {
          take();
          const args: Node[] = [];
          if (peek()?.type !== ")") {
            for (;;) {
              args.push(expression(0));
              if (peek()?.type === ",") {
                take();
                continue;
              }
              break;
            }
          }
          if (take().type !== ")") throw new CellError("#ERROR!", "missing )");
          return { kind: "call", name: upper, args };
        }
        if (upper === "TRUE" || upper === "FALSE") return { kind: "boolean", value: upper === "TRUE" };
        if (!parseAddress(upper)) throw new CellError("#NAME?", token.text);
        if (peek()?.type === ":") {
          take();
          const to = take();
          if (to.type !== "id" || !parseAddress(to.text)) throw new CellError("#REF!", "bad range");
          return { kind: "range", from: upper, to: to.text.toUpperCase() };
        }
        return { kind: "ref", ref: upper };
      }
      default:
        throw new CellError("#ERROR!", `unexpected ${token.text}`);
    }
  };

  /** Precedence climbing: parses operators binding at least as tightly as `minimum`. */
  const expression = (minimum: number): Node => {
    let left = primary();
    for (;;) {
      const token = peek();
      if (!token || token.type !== "op") break;
      const precedence = PRECEDENCE[token.text];
      if (precedence === undefined || precedence < minimum) break;
      take();
      // ^ is right-associative; everything else is left-associative.
      const right = expression(token.text === "^" ? precedence : precedence + 1);
      left = { kind: "binary", op: token.text, left, right };
    }
    return left;
  };

  const tree = expression(0);
  if (position < tokens.length) throw new CellError("#ERROR!", `unexpected ${tokens[position]?.text}`);
  return tree;
}

// ── evaluation ───────────────────────────────────────────────────────────

/** Interprets a raw cell entry: "=…" is a formula, numbers and TRUE/FALSE are values, anything else is text. */
export function literal(raw: string): CellValue {
  const text = raw.trim();
  if (text === "") return null;
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return Number(text);
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  return raw;
}

function toNumber(value: CellValue): number | CellError {
  if (value instanceof CellError) return value;
  if (value === null || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : new CellError("#VALUE!", `"${value}" is not a number`);
}

function toText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function truthy(value: CellValue): boolean | CellError {
  if (value instanceof CellError) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === null) return false;
  return value.toUpperCase() === "TRUE" ? true : value.toUpperCase() === "FALSE" ? false : value !== "";
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}

type Arg = CellValue | CellValue[];

function flatten(args: Arg[]): CellValue[] {
  return args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg]));
}

function numbers(args: Arg[], strict: boolean): number[] | CellError {
  const result: number[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) {
      // Inside ranges, text and blanks are skipped (as in common spreadsheets).
      for (const value of arg) {
        if (value instanceof CellError) return value;
        if (typeof value === "number") result.push(value);
        else if (typeof value === "boolean") result.push(value ? 1 : 0);
      }
    } else {
      const value = strict ? toNumber(arg) : typeof arg === "number" ? arg : toNumber(arg);
      if (value instanceof CellError) return value;
      result.push(value);
    }
  }
  return result;
}

const FUNCTIONS: Record<string, (args: Arg[]) => CellValue> = {
  SUM: (args) => {
    const values = numbers(args, true);
    return values instanceof CellError ? values : values.reduce((total, value) => total + value, 0);
  },
  AVERAGE: (args) => {
    const values = numbers(args, true);
    if (values instanceof CellError) return values;
    return values.length === 0 ? new CellError("#DIV/0!") : values.reduce((total, value) => total + value, 0) / values.length;
  },
  MIN: (args) => {
    const values = numbers(args, true);
    return values instanceof CellError ? values : values.length === 0 ? 0 : Math.min(...values);
  },
  MAX: (args) => {
    const values = numbers(args, true);
    return values instanceof CellError ? values : values.length === 0 ? 0 : Math.max(...values);
  },
  COUNT: (args) => flatten(args).filter((value) => typeof value === "number").length,
  COUNTA: (args) => flatten(args).filter((value) => value !== null && value !== "").length,
  ROUND: ([value, digits]) => {
    const number = toNumber((Array.isArray(value) ? value[0] : value) ?? null);
    const places = toNumber((Array.isArray(digits) ? digits[0] : digits) ?? 0);
    if (number instanceof CellError) return number;
    if (places instanceof CellError) return places;
    const factor = 10 ** Math.trunc(places);
    return Math.round(number * factor) / factor;
  },
  ABS: ([value]) => {
    const number = toNumber((Array.isArray(value) ? value[0] : value) ?? null);
    return number instanceof CellError ? number : Math.abs(number);
  },
  SQRT: ([value]) => {
    const number = toNumber((Array.isArray(value) ? value[0] : value) ?? null);
    if (number instanceof CellError) return number;
    return number < 0 ? new CellError("#VALUE!", "square root of a negative number") : Math.sqrt(number);
  },
  IF: ([condition, yes, no]) => {
    const test = truthy((Array.isArray(condition) ? condition[0] : condition) ?? null);
    if (test instanceof CellError) return test;
    const chosen = test ? yes : no;
    return (Array.isArray(chosen) ? chosen[0] : chosen) ?? (test ? true : false);
  },
  CONCAT: (args) => {
    const values = flatten(args);
    const error = values.find((value): value is CellError => value instanceof CellError);
    return error ?? values.map(toText).join("");
  },
  LEN: ([value]) => toText((Array.isArray(value) ? value[0] : value) ?? null).length,
  UPPER: ([value]) => toText((Array.isArray(value) ? value[0] : value) ?? null).toUpperCase(),
  LOWER: ([value]) => toText((Array.isArray(value) ? value[0] : value) ?? null).toLowerCase(),
};
FUNCTIONS.AVG = FUNCTIONS.AVERAGE as (args: Arg[]) => CellValue;

export const FORMULA_FUNCTIONS: readonly string[] = Object.keys(FUNCTIONS).sort();

function compare(op: string, left: CellValue, right: CellValue): CellValue {
  const a = typeof left === "string" || typeof right === "string" ? toText(left).toLowerCase() : toNumber(left);
  const b = typeof left === "string" || typeof right === "string" ? toText(right).toLowerCase() : toNumber(right);
  if (a instanceof CellError) return a;
  if (b instanceof CellError) return b;
  switch (op) {
    case "=":
      return a === b;
    case "<>":
      return a !== b;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    default:
      return a >= b;
  }
}

/**
 * Evaluates every cell of a sheet. Errors stay inside the cell that caused
 * them (and the cells depending on it); a reference cycle yields #CYCLE!.
 */
export function evaluateSheet(cells: Record<string, string>): Record<string, CellValue> {
  const results = new Map<string, CellValue>();
  const visiting = new Set<string>();
  const parsed = new Map<string, Node | CellError>();

  const cell = (ref: string): CellValue => {
    const key = ref.toUpperCase();
    const known = results.get(key);
    if (known !== undefined || results.has(key)) return known ?? null;
    if (visiting.has(key)) return new CellError("#CYCLE!");
    const raw = cells[key];
    if (raw === undefined) return null;
    if (!raw.startsWith("=")) {
      const value = literal(raw);
      results.set(key, value);
      return value;
    }
    visiting.add(key);
    let tree = parsed.get(key);
    if (!tree) {
      try {
        tree = parseFormula(raw.slice(1));
      } catch (error) {
        tree = error instanceof CellError ? error : new CellError("#ERROR!");
      }
      parsed.set(key, tree);
    }
    const value = tree instanceof CellError ? tree : evaluate(tree);
    visiting.delete(key);
    results.set(key, value);
    return value;
  };

  const evaluate = (node: Node): CellValue => {
    switch (node.kind) {
      case "number":
        return node.value;
      case "string":
        return node.value;
      case "boolean":
        return node.value;
      case "ref":
        return cell(node.ref);
      case "range":
        return new CellError("#VALUE!", "a range can only be used inside a function");
      case "unary": {
        const value = toNumber(evaluate(node.operand));
        return value instanceof CellError ? value : node.op === "-" ? -value : value;
      }
      case "binary": {
        const left = evaluate(node.left);
        const right = evaluate(node.right);
        if (left instanceof CellError) return left;
        if (right instanceof CellError) return right;
        if (node.op === "&") return toText(left) + toText(right);
        if (["=", "<>", "<", ">", "<=", ">="].includes(node.op)) return compare(node.op, left, right);
        const a = toNumber(left);
        const b = toNumber(right);
        if (a instanceof CellError) return a;
        if (b instanceof CellError) return b;
        let result: number;
        switch (node.op) {
          case "+":
            result = a + b;
            break;
          case "-":
            result = a - b;
            break;
          case "*":
            result = a * b;
            break;
          case "/":
            if (b === 0) return new CellError("#DIV/0!");
            result = a / b;
            break;
          default:
            result = a ** b;
        }
        return Number.isFinite(result) ? result : new CellError("#VALUE!");
      }
      case "call": {
        const fn = FUNCTIONS[node.name];
        if (!fn) return new CellError("#NAME?", node.name);
        const args: Arg[] = node.args.map((arg) => {
          if (arg.kind === "range") {
            const refs = rangeCells(arg.from, arg.to);
            return refs ? refs.map(cell) : new CellError("#REF!");
          }
          return evaluate(arg);
        });
        return fn(args);
      }
    }
  };

  const out: Record<string, CellValue> = {};
  for (const ref of Object.keys(cells)) out[ref.toUpperCase()] = cell(ref);
  return out;
}

/** How a computed value is shown in a cell. */
export function display(value: CellValue): string {
  if (value instanceof CellError) return value.code;
  return toText(value);
}
