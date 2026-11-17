import {
  ClaspError,
  applyOperations,
  createGraph,
  createId,
  isClaspError,
  issue,
  toClaspError,
  type ClaspGraph,
  type ClaspIssue,
  type GraphOperation,
  type GraphStore,
  type TransactionResult,
} from "@clasp/core";
import { compileFeatures, type FeatureExtension } from "@clasp/features";
import type { ComponentRegistry } from "@clasp/runtime";
import type { SchemaDefinition, SchemaRegistry } from "@clasp/schemas";
import { buildSystemPrompt, buildUserPrompt } from "./context";
import { PLAN_JSON_SCHEMA, parsePlan, resolvePlan, type GraphPlan, type PlanIssue, type ResolveOptions } from "./plan";
import type { AIProvider, ChatMessage } from "./provider";

/** Where a proposal's changes go: the application it was asked from, or a brand-new one. */
export type ProposalTarget = { kind: "current" } | { kind: "new"; name: string };

/**
 * Whether a request asks for a separate application rather than a change.
 * Deliberately narrow: "make a calendar app" yes, "make the app show done tasks" no.
 */
export function asksForNewApp(request: string): boolean {
  return /\b(make|create|build|start|set up|write|design)\s+(me\s+|us\s+)?(a|an|another|new|my|one)\s+([\w-]+\s+){0,3}(app|application|program|tool)\b/i.test(request) || /\bnew\s+(app|application)\b/i.test(request);
}

function nameFor(plan: GraphPlan, request: string): string {
  if (plan.title?.trim()) return plan.title.trim();
  const match = /\b(?:a|an|another|new|my|one)\s+((?:[\w-]+\s+){0,3}?)(?:app|application|program|tool)\b/i.exec(request);
  const words = match?.[1]?.trim();
  return words ? words.replace(/\b\w/g, (char) => char.toUpperCase()) : "New app";
}

/** A validated set of changes waiting for the user's approval. Applying it is a separate, explicit step. */
/** Names an application gets before anyone has named it: "Untitled app", "Untitled app 2", … */
export function isPlaceholderName(name: string): boolean {
  return /^untitled( app)?( \d+)?$/i.test(name.trim());
}

export interface Proposal {
  id: string;
  request: string;
  summary: string;
  /** The application the changes are for. A "new" target is created when the proposal is applied. */
  target: ProposalTarget;
  /** What the change does, one line per feature, in plain language. */
  features: string[];
  /** What the model proposed, in its own format. */
  plan: GraphPlan;
  /** The same thing as ordinary graph operations — valid as one transaction against `baseVersion`. */
  operations: GraphOperation[];
  /** Record schemas the change defines; registered when it is applied. */
  schemas: SchemaDefinition[];
  /** The graph as it would be after applying. */
  preview: ClaspGraph;
  /** Non-blocking findings about the resulting graph. */
  warnings: ClaspIssue[];
  /** Graph revision the proposal was computed against. */
  baseVersion: number;
  /** How many replies it took (1 = valid on the first try). */
  attempts: number;
  provider: { id: string; label: string; kind: "llm" | "scripted"; model?: string };
}

export type AssistantProgress =
  | { stage: "asking"; attempt: number }
  | { stage: "validating"; attempt: number }
  | { stage: "repairing"; attempt: number; issues: PlanIssue[] };

export interface ProposeInput {
  request: string;
  graph: ClaspGraph;
  signal?: AbortSignal;
  onProgress?: (progress: AssistantProgress) => void;
}

export interface AssistantOptions extends ResolveOptions {
  provider: AIProvider;
  registry: ComponentRegistry;
  schemas: SchemaRegistry;
  /** Feature kinds implemented outside the core feature compiler (documents, files, …). */
  extensions?: readonly FeatureExtension[];
  /** How many times an invalid plan is sent back to the model for correction. */
  maxRepairs?: number;
  /** Whether another application already has this name (so a proposed name can avoid it). */
  nameTaken?: (name: string) => boolean;
}

function describeIssues(plan: GraphPlan | undefined, issues: readonly PlanIssue[]): string {
  return issues
    .map((entry) => {
      const operation = entry.index >= 0 ? plan?.operations[entry.index] : undefined;
      const where = operation ? `operation ${entry.index + 1} (${JSON.stringify(operation)})` : "plan";
      return `- ${where}: ${entry.message}`;
    })
    .join("\n");
}

interface Built {
  operations: GraphOperation[];
  schemas: SchemaDefinition[];
  features: string[];
  preview: ClaspGraph;
  issues: PlanIssue[];
}

/**
 * Turns a natural-language request into a validated graph proposal.
 *
 * The model describes the application by its features (entities, forms,
 * lists, search, documents…); the deterministic feature compiler turns those
 * into components and wiring. The result is simulated against the real graph
 * and registry; problems go back to the model, phrased in feature terms, for
 * correction. The assistant never changes an application — `applyProposal`
 * does, as an ordinary transaction.
 */
export class GraphAssistant {
  private readonly provider: AIProvider;
  private readonly registry: ComponentRegistry;
  private readonly schemas: SchemaRegistry;
  private readonly extensions: readonly FeatureExtension[];
  private readonly maxRepairs: number;
  private readonly resolveOptions: ResolveOptions;
  private readonly nameTaken: (name: string) => boolean;

  constructor(options: AssistantOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.schemas = options.schemas;
    this.extensions = options.extensions ?? [];
    this.maxRepairs = options.maxRepairs ?? 2;
    this.nameTaken = options.nameTaken ?? (() => false);
    this.resolveOptions = { ...(options.allowDataLoss ? { allowDataLoss: true } : {}), schemas: options.schemas };
  }

  /** Decides whether a plan belongs in the current application or a new one. */
  targetFor(plan: GraphPlan, request: string, graph: ClaspGraph): ProposalTarget {
    const empty = Object.keys(graph.objects).length === 0;
    if (empty) return { kind: "current" };
    const wantsNew = plan.app === "new" || (plan.app !== "current" && asksForNewApp(request));
    return wantsNew ? { kind: "new", name: nameFor(plan, request) } : { kind: "current" };
  }

  /** The graph a target's changes are compiled against: the current one, or an empty new application. */
  private baseFor(target: ProposalTarget, graph: ClaspGraph): ClaspGraph {
    return target.kind === "new" ? createGraph({ name: target.name, now: graph.metadata.createdAt }) : graph;
  }

  /**
   * Rebuilds a proposal for another target without asking the model again —
   * e.g. "add this to the current application instead". Deterministic.
   */
  retarget(proposal: Proposal, target: ProposalTarget, graph: ClaspGraph): Proposal {
    const base = this.baseFor(target, graph);
    const built = this.build(target.kind === "new" ? { ...proposal.plan, title: proposal.plan.title ?? target.name } : proposal.plan, base);
    if (built.issues.length > 0) {
      throw new ClaspError("VALIDATION_FAILED", built.issues[0]?.message ?? "The plan does not fit there.", {
        issues: built.issues.map((entry) => issue("INVALID_PLAN", entry.message)),
      });
    }
    return {
      ...proposal,
      id: createId("proposal"),
      target,
      features: built.features,
      operations: built.operations,
      schemas: built.schemas,
      preview: built.preview,
      baseVersion: base.version,
    };
  }

  /** Compiles a plan (features first, then any raw operations) and checks the combined result. */
  build(plan: GraphPlan, graph: ClaspGraph): Built {
    const issues: PlanIssue[] = [];
    const operations: GraphOperation[] = [];
    let preview = graph;
    let schemas: SchemaDefinition[] = [];
    let features: string[] = [];

    const hasFeatures = (plan.features?.length ?? 0) > 0 || (plan.entities?.length ?? 0) > 0 || plan.title !== undefined;
    if (!hasFeatures && plan.operations.length === 0) {
      return { operations, schemas, features, preview, issues: [{ index: -1, message: "The plan describes no features." }] };
    }
    if (hasFeatures) {
      const compiled = compileFeatures(
        {
          ...(plan.title ? { title: plan.title } : {}),
          ...(plan.subtitle ? { subtitle: plan.subtitle } : {}),
          ...(plan.entities ? { entities: plan.entities } : {}),
          ...(plan.features ? { features: plan.features } : {}),
        },
        { graph, registry: this.registry, schemas: this.schemas },
        this.extensions,
      );
      for (const message of compiled.issues) issues.push({ index: -1, message });
      schemas = compiled.schemas;
      features = compiled.described;
      if (compiled.issues.length === 0) {
        try {
          preview = applyOperations(graph, compiled.operations, { catalog: this.registry }).graph;
          operations.push(...compiled.operations);
        } catch (error) {
          // A compiler bug or an unexpected graph shape; report it rather than guess.
          const claspError = toClaspError(error);
          const details = isClaspError(error) ? claspError.issues.filter((entry) => entry.severity === "error").map((entry) => entry.message) : [];
          for (const message of details.length > 0 ? details : [claspError.message]) issues.push({ index: -1, message });
        }
      }
    }
    if (plan.operations.length > 0 && issues.length === 0) {
      const resolved = resolvePlan(plan, preview, this.registry, this.resolveOptions);
      issues.push(...resolved.issues);
      if (resolved.issues.length === 0) {
        operations.push(...resolved.operations);
        preview = resolved.preview;
        features = [...features, `${resolved.operations.length} further change${resolved.operations.length === 1 ? "" : "s"} to the application's wiring`];
      }
    }
    // An application nobody has named yet is named after what it now is.
    const title = plan.title?.trim();
    if (issues.length === 0 && title && isPlaceholderName(graph.metadata.name) && !isPlaceholderName(title)) {
      let name = title;
      for (let index = 2; this.nameTaken(name); index++) name = `${title} ${index}`;
      const rename: GraphOperation = { op: "setMetadata", name };
      preview = applyOperations(preview, [rename], { catalog: this.registry }).graph;
      operations.push(rename);
      features = [...features, `Names the application “${name}”`];
    }
    return { operations, schemas, features, preview, issues };
  }

  /**
   * Rejects with UNAVAILABLE when the provider cannot be reached, or with
   * VALIDATION_FAILED (carrying one issue per problem) when no valid plan was
   * produced within the repair budget.
   */
  async propose(input: ProposeInput): Promise<Proposal> {
    const request = input.request.trim();
    if (!request) throw new ClaspError("VALIDATION_FAILED", "Describe what you would like to build or change.");

    const status = await this.provider.status();
    if (!status.available) throw new ClaspError("UNAVAILABLE", status.reason ?? `${this.provider.label} is not available.`);

    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt({ registry: this.registry, schemas: this.schemas }) },
      { role: "user", content: buildUserPrompt({ request, graph: input.graph, schemas: this.schemas }) },
    ];
    let lastIssues: PlanIssue[] = [];
    let lastPlan: GraphPlan | undefined;

    for (let attempt = 1; attempt <= this.maxRepairs + 1; attempt++) {
      input.onProgress?.({ stage: "asking", attempt });
      let reply: string;
      try {
        reply = await this.provider.complete({ messages, schema: PLAN_JSON_SCHEMA, ...(input.signal ? { signal: input.signal } : {}) });
      } catch (error) {
        throw toClaspError(error, "UNAVAILABLE");
      }
      input.onProgress?.({ stage: "validating", attempt });

      let plan: GraphPlan | undefined;
      let built: Built | undefined;
      let target: ProposalTarget = { kind: "current" };
      let base = input.graph;
      let issues: PlanIssue[];
      try {
        plan = parsePlan(reply);
        target = this.targetFor(plan, request, input.graph);
        base = this.baseFor(target, input.graph);
        built = this.build(target.kind === "new" ? { ...plan, title: plan.title ?? target.name } : plan, base);
        issues = built.issues;
      } catch (error) {
        issues = [{ index: -1, message: toClaspError(error).message }];
      }

      if (issues.length === 0 && plan && built) {
        return {
          id: createId("proposal"),
          request,
          summary: plan.summary || "Proposed changes",
          target,
          features: built.features,
          plan,
          operations: built.operations,
          schemas: built.schemas,
          preview: built.preview,
          warnings: [],
          baseVersion: base.version,
          attempts: attempt,
          provider: {
            id: this.provider.id,
            label: this.provider.label,
            kind: this.provider.kind,
            ...(status.model ? { model: status.model } : {}),
          },
        };
      }

      lastIssues = issues;
      lastPlan = plan;
      if (attempt <= this.maxRepairs) {
        input.onProgress?.({ stage: "repairing", attempt, issues });
        messages.push({ role: "assistant", content: reply });
        messages.push({
          role: "user",
          content: `Your plan was rejected:\n${describeIssues(plan, issues)}\n\nReply with the complete corrected plan as one JSON object. Fix every problem listed; keep everything that was fine.`,
        });
      }
    }

    throw new ClaspError(
      "VALIDATION_FAILED",
      `The model did not produce a valid plan after ${this.maxRepairs + 1} attempts. ${lastIssues[0]?.message ?? ""}`.trim(),
      {
        issues: lastIssues.map((entry) => issue("INVALID_PLAN", entry.message)),
        details: { explanation: describeIssues(lastPlan, lastIssues) },
      },
    );
  }
}

/**
 * Applies an approved proposal as one undoable transaction, registering any
 * record schemas it defines first. The store validates everything again, so a
 * proposal that no longer fits the graph is rejected as a whole.
 */
export function applyProposal(store: GraphStore, proposal: Proposal, schemas?: SchemaRegistry): TransactionResult {
  // For a "new" target, `store` is the freshly created (empty) application.
  if (proposal.schemas.length > 0) {
    if (!schemas) throw new ClaspError("INVALID_OPERATION", "This proposal defines record schemas; pass the workspace's schema registry to apply it.");
    for (const schema of proposal.schemas) if (!schemas.has(schema.id, schema.version)) schemas.register(schema);
  }
  const label = `AI: ${proposal.summary}`;
  if (store.graph.version !== proposal.baseVersion) {
    // The graph moved on; the transaction below still validates everything, but say so if it fails.
    try {
      return store.transact(proposal.operations, { origin: "ai", label });
    } catch (error) {
      const claspError = toClaspError(error);
      throw new ClaspError("CONFLICT", `The application changed since this proposal was made, and it no longer applies: ${claspError.message}`, {
        issues: claspError.issues,
      });
    }
  }
  return store.transact(proposal.operations, { origin: "ai", label });
}
