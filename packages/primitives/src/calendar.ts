import { isJsonObject, type JsonObject, type JsonValue } from "@clasp/core";
import type { ComponentDefinition } from "@clasp/runtime";
import { VISIBLE, asRows, asText } from "./helpers";

/** "2026-11-20T09:30" or "2026-11-20" → "2026-11-20"; anything else → undefined. */
export function dayOf(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match?.[1];
}

/**
 * A month calendar of records, placed by a date field. Which month is shown
 * is presentation state (the renderer's); the component holds the records,
 * the picked day and the selected record.
 */
export const calendar: ComponentDefinition = {
  type: "ui.calendar",
  version: 1,
  category: "interface",
  title: "Calendar",
  description:
    'Shows records on a month calendar by a date field. Clicking a day emits "dayPicked" with the date (YYYY-MM-DD) — connect it to a date input\'s "set" to prefill a form; clicking an entry emits "select" with the record.',
  properties: [
    { name: "dateField", type: "field", default: "start", title: "Date field" },
    { name: "titleField", type: "field", default: "title", title: "Title field" },
    { name: "weekStartsOn", type: "enum", options: ["monday", "sunday"], default: "monday", title: "Weeks start on" },
  ],
  inputs: [{ name: "items", type: "records", description: "The records to place on the calendar." }, VISIBLE],
  outputs: [
    { name: "selectedDate", type: "string", description: "The picked day, YYYY-MM-DD." },
    { name: "selected", type: "record" },
    { name: "count", type: "number", description: "Records that have a date." },
    { name: "onSelectedDate", type: "records", description: "Records on the picked day." },
  ],
  events: [
    { name: "dayPicked", payload: "string", description: "A day was clicked. Payload: YYYY-MM-DD." },
    { name: "select", payload: "record", description: "An entry was clicked. Payload: the record." },
  ],
  actions: [{ name: "pick", payload: "string", description: "Picks a day (YYYY-MM-DD)." }],
  create: (ctx) => {
    const field = (): string => asText(ctx.props.dateField, "start");
    const sync = (): void => {
      const rows = asRows(ctx.input("items"));
      const dated = rows.filter((row) => dayOf(row[field()]) !== undefined);
      ctx.setOutput("count", dated.length);
      const day = ctx.getState<string>("day");
      ctx.setOutput("selectedDate", day);
      ctx.setOutput("onSelectedDate", day ? dated.filter((row) => dayOf(row[field()]) === day) : []);
      const selected = ctx.getState<string>("selected");
      ctx.setOutput("selected", rows.find((row) => row.id === selected));
    };
    const pick = (payload: JsonValue | undefined, announce: boolean): void => {
      const day = dayOf(payload);
      if (!day) return;
      ctx.setState("day", day);
      sync();
      if (announce) ctx.emit("dayPicked", day);
    };
    sync();
    return {
      onInput: sync,
      actions: { pick: (payload) => pick(payload, false) },
      interactions: {
        pick: (payload) => pick(payload, true),
        select: (payload) => {
          const id = isJsonObject(payload) ? payload.id : undefined;
          const row: JsonObject | undefined = asRows(ctx.input("items")).find((candidate) => candidate.id === id);
          if (!row) return;
          ctx.setState("selected", row.id as string);
          sync();
          ctx.emit("select", row);
        },
      },
    };
  },
};
