import { ComponentRegistry, type ComponentDefinition } from "@clasp/runtime";
import { calendar } from "./calendar";
import { compositionPrimitives } from "./composition";
import { dataPrimitives } from "./data";
import { editorPrimitives } from "./editors";
import { gamePrimitives } from "./games";
import { interfacePrimitives } from "./interface";
import { logicPrimitives } from "./logic";
import { monitorPrimitives } from "./monitor";
import { terminalPrimitives } from "./terminal";
import { toolPrimitives } from "./tools";

export { compositionPrimitives, dataPrimitives, editorPrimitives, interfacePrimitives, logicPrimitives };
export { OPERATORS, fillTemplate, test as testOperator } from "./helpers";
export { CellError, FORMULA_FUNCTIONS, columnName, display as displayCell, evaluateSheet, parseAddress } from "./formula";
export { SEQUENCER_SOUNDS } from "./editors";
export { dayOf } from "./calendar";
export { countWords, parseInline, parseMarkdown, type Block, type Span } from "./markdown";
export { calculate, formatDuration } from "./tools";
export { TERMINAL_COMMANDS, parseCommand } from "./terminal";
export { GUESS_WORDS, PAIR_SYMBOLS, bestMove, lineOf, nextRandom } from "./games";

/** Every built-in primitive. */
export const primitives: ComponentDefinition[] = [
  ...interfacePrimitives,
  calendar,
  ...editorPrimitives,
  ...toolPrimitives,
  ...terminalPrimitives,
  ...monitorPrimitives,
  ...gamePrimitives,
  ...dataPrimitives,
  ...logicPrimitives,
  ...compositionPrimitives,
];

/** Registers the built-in primitives into a registry (a new one unless given). */
export function registerPrimitives(registry: ComponentRegistry = new ComponentRegistry()): ComponentRegistry {
  return registry.registerAll(primitives);
}
