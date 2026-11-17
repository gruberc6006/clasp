import type { JsonObject } from "@clasp/core";
import type { NetworkService } from "@clasp/network";
import type { Workspace } from "@clasp/runtime";

/**
 * Measures what a web page can measure about itself, for the System service.
 * Browsers do not expose the computer's CPU usage; "busy" is how much of the
 * last second this tab's main thread spent on long tasks (from the Long Tasks
 * API where the browser supports it).
 *
 * Measuring costs a little, so it runs only while someone is reading the
 * metrics and stops after a few quiet seconds.
 */
export class BrowserMetrics {
  private running = false;
  private lastRead = 0;
  private busyMs = 0;
  private busy: number | undefined;
  private lagMs = 0;
  private lagWindow = 0;
  private frames = 0;
  private fps: number | undefined;
  private storage: { used: number; quota: number } | undefined;
  private steps = 0;
  private stepsPerSecond = 0;
  private stops: Array<() => void> = [];

  constructor(
    private readonly workspace: () => Workspace | undefined,
    private readonly network: () => NetworkService | undefined,
  ) {}

  sample(): JsonObject {
    this.lastRead = Date.now();
    if (!this.running) this.start();
    const workspace = this.workspace();
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    const result: JsonObject = {
      lagMs: Math.round(this.lagMs),
      cores: navigator.hardwareConcurrency || 0,
      stepsPerSecond: Math.round(this.stepsPerSecond),
      connections: this.network()?.connections().length ?? 0,
    };
    if (this.busy !== undefined) result.busy = Math.round(this.busy);
    if (this.fps !== undefined) result.fps = this.fps;
    if (memory) {
      result.heapUsedMb = Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10;
      result.heapLimitMb = Math.round(memory.jsHeapSizeLimit / 1048576);
    }
    if (this.storage) {
      result.storageUsedMb = Math.round((this.storage.used / 1048576) * 10) / 10;
      result.storageQuotaMb = Math.round(this.storage.quota / 1048576);
    }
    if (workspace) {
      result.apps = workspace.apps().length;
      result.records = workspace.kernel
        .listResources()
        .filter((resource) => resource.kind === "collection")
        .reduce((total, resource) => total + workspace.kernel.data.count(resource.id), 0);
    }
    return result;
  }

  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
    this.running = false;
  }

  private start(): void {
    this.running = true;
    const longTasks = typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask");
    if (longTasks) {
      this.busy = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.busyMs += entry.duration;
      });
      observer.observe({ type: "longtask", buffered: false });
      this.stops.push(() => observer.disconnect());
    }
    // Timer lag: how late a 100 ms timer fires.
    let expected = performance.now() + 100;
    const lag = setInterval(() => {
      const now = performance.now();
      this.lagWindow = Math.max(this.lagWindow, now - expected);
      expected = now + 100;
    }, 100);
    this.stops.push(() => clearInterval(lag));
    // Frames.
    let frame = 0;
    const count = (): void => {
      this.frames++;
      frame = requestAnimationFrame(count);
    };
    frame = requestAnimationFrame(count);
    this.stops.push(() => cancelAnimationFrame(frame));
    // Once a second: fold the window into the published figures.
    let last = performance.now();
    this.steps = this.totalSteps();
    const second = setInterval(() => {
      const now = performance.now();
      const elapsed = Math.max(1, now - last);
      last = now;
      if (longTasks) this.busy = Math.min(100, (this.busyMs / elapsed) * 100);
      this.busyMs = 0;
      this.lagMs = this.lagWindow;
      this.lagWindow = 0;
      this.fps = Math.round((this.frames * 1000) / elapsed);
      this.frames = 0;
      const steps = this.totalSteps();
      this.stepsPerSecond = ((steps - this.steps) * 1000) / elapsed;
      this.steps = steps;
      if (Date.now() - this.lastRead > 5000) this.stop();
    }, 1000);
    this.stops.push(() => clearInterval(second));
    const estimate = (): void => {
      void navigator.storage
        ?.estimate?.()
        .then((value) => {
          this.storage = { used: value.usage ?? 0, quota: value.quota ?? 0 };
        })
        .catch(() => undefined);
    };
    estimate();
    const storage = setInterval(estimate, 10_000);
    this.stops.push(() => clearInterval(storage));
  }

  private totalSteps(): number {
    return (this.workspace()?.apps() ?? []).reduce((total, app) => total + app.runtime.steps, 0);
  }
}
