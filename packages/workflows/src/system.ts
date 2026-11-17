import type { JsonObject } from "@clasp/core";
import { SYSTEM_PRINCIPAL, type ClaspKernel } from "@clasp/universal-api";

/** Resource id of the system metrics service. */
export const SYSTEM_METRICS_ID = "clasp.metrics";

/** Measures the host. Supplied by the Studio (browser measurements) or a test. */
export type MetricsSampler = () => JsonObject;

/** The metrics a sampler may report. All are optional; hosts report what they can measure. */
export const SYSTEM_METRICS = [
  { name: "busy", description: "Share of the last second this tab's main thread spent on long tasks, 0–100." },
  { name: "lagMs", description: "How late timers ran, in milliseconds (event-loop lag)." },
  { name: "fps", description: "Frames drawn per second." },
  { name: "heapUsedMb", description: "JavaScript memory in use (Chrome only)." },
  { name: "heapLimitMb", description: "JavaScript memory limit (Chrome only)." },
  { name: "cores", description: "Logical processors the browser reports." },
  { name: "storageUsedMb", description: "Storage this site uses." },
  { name: "storageQuotaMb", description: "Storage this site may use." },
  { name: "apps", description: "Applications in the workspace." },
  { name: "stepsPerSecond", description: "Runtime steps executed per second, all applications." },
  { name: "records", description: "Records stored in the workspace." },
  { name: "connections", description: "Open network connections." },
] as const;

/**
 * Exposes measurements of the host as the outputs of a system service.
 * Reading them needs `object.read` on `clasp.metrics`, which the user grants
 * like any other access: what is installed and how busy the machine is are
 * not every application's business.
 */
export class SystemMetrics {
  constructor(
    kernel: ClaspKernel,
    private sampler: MetricsSampler = () => ({}),
  ) {
    kernel.addResources(SYSTEM_PRINCIPAL, [
      {
        id: SYSTEM_METRICS_ID,
        kind: "service",
        name: "System",
        description: "How this workspace and browser tab are doing: main-thread load, memory, frame rate, storage, applications and activity.",
        ownerId: SYSTEM_PRINCIPAL,
        exposure: "discoverable",
        outputs: SYSTEM_METRICS.map((metric) => ({ name: metric.name, description: metric.description })),
      },
    ]);
    kernel.bindProvider(SYSTEM_METRICS_ID, { values: () => this.sampler() });
  }

  setSampler(sampler: MetricsSampler): void {
    this.sampler = sampler;
  }
}
