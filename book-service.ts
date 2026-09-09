import type { ScholarBook, ScholarConfig } from "./types.ts";
import { normalizeVaultPathKey } from "./transcript-recovery.ts";
import { assertDurableHistoryPreserved } from "./history.ts";

export type BookServicePorts = {
  getConfig(): ScholarConfig;
  load(config: ScholarConfig, bookId: string): Promise<ScholarBook | undefined>;
  save(config: ScholarConfig, book: ScholarBook, expectedRevision: number): Promise<unknown>;
  list(config: ScholarConfig): Promise<ScholarBook[]>;
  project(config: ScholarConfig, books: ScholarBook[]): Promise<void>;
  onSave(book: ScholarBook): void;
  librarySetupMessage: string;
};

export type MutationOutcome<T> = {
  book: ScholarBook;
  result: T;
  projectionStatus: "synced" | "pending";
  projectionError?: unknown;
};

type VaultQueueEntry = {
  activeConfig: ScholarConfig;
  currentPromise: Promise<void> | null;
  needsRerun: boolean;
  pending: boolean;
  waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }>;
};

const bookQueues = new Map<string, Promise<void>>();
const vaultQueues = new Map<string, VaultQueueEntry>();

export function createBookService(ports: BookServicePorts) {
  const projectVault = (config: ScholarConfig): Promise<void> => {
    const vaultKey = normalizeVaultPathKey(config.obsidianRoot);
    if (!vaultKey) return Promise.resolve();

    let entry = vaultQueues.get(vaultKey);
    if (!entry) {
      entry = {
        activeConfig: structuredClone(config),
        currentPromise: null,
        needsRerun: false,
        pending: false,
        waiters: [],
      };
      vaultQueues.set(vaultKey, entry);
    }
    entry.activeConfig = structuredClone(config);

    return new Promise<void>((resolve, reject) => {
      entry!.waiters.push({ resolve, reject });

      if (entry!.currentPromise) {
        entry!.needsRerun = true;
        return;
      }

      const run = async () => {
        try {
          while (true) {
            entry!.needsRerun = false;
            const currentWaiters = entry!.waiters;
            entry!.waiters = [];
            const targetConfig = structuredClone(entry!.activeConfig);
            let passError: unknown = null;
            try {
              if (!targetConfig.obsidianRoot.trim()) {
                entry!.pending = false;
              } else {
                const books = await ports.list(targetConfig);
                if (books.length > 0) {
                  await ports.project(targetConfig, books);
                }
                entry!.pending = false;
              }
            } catch (err) {
              entry!.pending = true;
              passError = err;
            }
            for (const waiter of currentWaiters) {
              if (passError) waiter.reject(passError);
              else waiter.resolve();
            }
            if (entry!.needsRerun) {
              continue;
            }
            break;
          }
        } finally {
          entry!.currentPromise = null;
        }
      };

      entry!.currentPromise = run();
    });
  };

  const renderAll = async (configOverride?: ScholarConfig): Promise<void> => {
    const config = structuredClone(configOverride || ports.getConfig());
    await projectVault(config);
  };

  const isPending = (configOverride?: ScholarConfig): boolean => {
    const config = configOverride || ports.getConfig();
    const vaultKey = normalizeVaultPathKey(config.obsidianRoot);
    if (!vaultKey) return false;
    return vaultQueues.get(vaultKey)?.pending ?? false;
  };

  const sync = async (configOverride?: ScholarConfig): Promise<{ synced: boolean; error?: unknown }> => {
    const config = structuredClone(configOverride || ports.getConfig());
    if (!config.obsidianRoot.trim()) return { synced: true };
    try {
      await projectVault(config);
      return { synced: true };
    } catch (error) {
      return { synced: false, error };
    }
  };

  const mutateBook = async <T>(
    bookId: string,
    mutate: (book: ScholarBook) => Promise<T> | T,
  ): Promise<MutationOutcome<T>> => {
    // One operation belongs to one vault even if the user changes the selected
    // configuration while an asynchronous mutation is still settling.
    const config = structuredClone(ports.getConfig());
    if (!config.libraryRoot.trim()) throw new Error(ports.librarySetupMessage);
    const queueKey = `${normalizeVaultPathKey(config.obsidianRoot)}\u0000${bookId.toLowerCase()}`;
    const previous = bookQueues.get(queueKey) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const queued = previous.catch(() => undefined).then(() => gate);
    bookQueues.set(queueKey, queued);
    await previous.catch(() => undefined);
    try {
      const book = await ports.load(config, bookId);
      if (!book) throw new Error(`Scholar book state is missing: ${bookId}`);
      const original = structuredClone(book);
      const result = await mutate(book);
      if (
        book.id !== original.id
        || book.instanceId !== original.instanceId
        || book.revision !== original.revision
      ) {
        throw new Error("Scholar mutation changed immutable book identity or revision fields.");
      }
      if (JSON.stringify(book) === JSON.stringify(original)) {
        return {
          book: original,
          result,
          projectionStatus: isPending(config) ? "pending" : "synced",
        };
      }
      assertDurableHistoryPreserved(original, book);
      book.revision += 1;
      book.updatedAt = new Date().toISOString();
      await ports.save(config, book, original.revision);
      try {
        ports.onSave(book);
      } catch {
        // Notification failure after commit must not fail the state save.
      }
      let projectionStatus: "synced" | "pending" = "synced";
      let projectionError: unknown;
      try {
        await projectVault(config);
      } catch (renderError) {
        projectionStatus = "pending";
        projectionError = renderError;
      }
      return {
        book,
        result,
        projectionStatus,
        ...(projectionError !== undefined ? { projectionError } : {}),
      };
    } finally {
      release();
      if (bookQueues.get(queueKey) === queued) bookQueues.delete(queueKey);
    }
  };

  return { renderAll, mutateBook, isPending, sync };
}
