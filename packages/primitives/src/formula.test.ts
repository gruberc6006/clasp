import { describe, expect, it } from "vitest";
import { CellError, display, evaluateSheet, parseFormula } from "./formula";

const shown = (cells: Record<string, string>) => Object.fromEntries(Object.entries(evaluateSheet(cells)).map(([ref, value]) => [ref, display(value)]));

describe("spreadsheet formulas", () => {
  it("evaluates arithmetic with the usual precedence", () => {
    expect(shown({ A1: "=1+2*3", A2: "=(1+2)*3", A3: "=2^3^2", A4: "=-4+10/4", A5: "=7-2-1" })).toEqual({
      A1: "7",
      A2: "9",
      A3: "512",
      A4: "-1.5",
      A5: "4",
    });
  });

  it("follows references and ranges, in any order", () => {
    expect(
      shown({ C1: "=SUM(A1:B2)", A1: "1", B1: "2", A2: "3", B2: "=A2*2", D1: "=AVERAGE(A1:A2)", D2: "=MAX(A1:B2)-MIN(A1:B2)", D3: "=COUNT(A1:D2)" }),
    ).toEqual({ C1: "12", A1: "1", B1: "2", A2: "3", B2: "6", D1: "2", D2: "5", D3: "7" });
  });

  it("handles text, comparison, IF and string functions", () => {
    expect(
      shown({ A1: "Ada", A2: '=CONCAT("Hello, ", A1, "!")', A3: '=A1&" Lovelace"', A4: "=IF(B1>10, \"big\", \"small\")", B1: "12", A5: "=UPPER(A1)", A6: "=LEN(A1)", A7: "=ROUND(2/3, 2)" }),
    ).toEqual({ A1: "Ada", A2: "Hello, Ada!", A3: "Ada Lovelace", A4: "big", B1: "12", A5: "ADA", A6: "3", A7: "0.67" });
  });

  it("reports errors in the cells that cause them and the cells that depend on them", () => {
    expect(
      shown({ A1: "=1/0", A2: "=A1+1", B1: "=NOPE(1)", B2: "=A3", A3: "=B2", C1: '="x"*2', C2: "=1+", C3: "=ZZZZ1+1" }),
    ).toEqual({ A1: "#DIV/0!", A2: "#DIV/0!", B1: "#NAME?", B2: "#CYCLE!", A3: "#CYCLE!", C1: "#VALUE!", C2: "#ERROR!", C3: "#NAME?" });
  });

  it("never evaluates code", () => {
    // Anything that is not part of the formula language is rejected by the parser.
    expect(() => parseFormula("constructor.constructor('return 1')()")).toThrowError(CellError);
    expect(shown({ A1: "=alert(1)", A2: "=globalThis" })).toEqual({ A1: "#NAME?", A2: "#NAME?" });
  });
});
