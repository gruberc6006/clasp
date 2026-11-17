/**
 * Globally unique identities.
 *
 * Ids are `<prefix>_<uuid without dashes>`; the prefix is only a readability
 * aid (`obj`, `con`, `app`, `rec`, …) and carries no meaning to the platform.
 */

function randomHex(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID().replace(/-/g, "");
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Clasp requires a Web Crypto implementation to mint identities.");
}

export function createId(prefix: string): string {
  return `${prefix}_${randomHex()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** A tiny typed event emitter used wherever the platform propagates changes. */
export class Emitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  subscribe(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  get size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}
