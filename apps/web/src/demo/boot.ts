import type { Kysely } from "kysely";
import { createDb, ensureDemo, migrate, type DB } from "@pet-pos/db";
import { WorkerDbClient } from "./db-client.ts";
import { DEMO_DATA_DIR } from "./protocol.ts";

export interface DemoRuntime {
  db: Kysely<DB>;
  /** Deletes this device's demo data; the page reloads afterwards. */
  reset(): Promise<void>;
}

export class OtherTabError extends Error {
  constructor() {
    super(
      "The register is already open in another tab or window. Use that one, or close it and reload this page.",
    );
  }
}

let booting: Promise<DemoRuntime> | null = null;

/** Opens the in-browser database, applies migrations and loads the sample store on first visit. Runs once per page. */
export function bootDemo(): Promise<DemoRuntime> {
  booting ??= start();
  return booting;
}

async function start(): Promise<DemoRuntime> {
  if (!(await holdTabLock())) throw new OtherTabError();

  const client = new WorkerDbClient(
    new Worker(new URL("./db.worker.ts", import.meta.url), { type: "module" }),
  );
  await client.open(DEMO_DATA_DIR);
  await migrate(client);
  const db = createDb(client);
  await ensureDemo(db, { salesHistory: true });

  return {
    db,
    async reset() {
      await client.wipe(DEMO_DATA_DIR);
    },
  };
}

/**
 * Only one tab may use the demo database: two tabs writing the same IndexedDB store can corrupt it.
 * The lock is held for the life of the tab.
 */
function holdTabLock(): Promise<boolean> {
  if (!("locks" in navigator)) return Promise.resolve(true);
  return new Promise((resolve) => {
    void navigator.locks.request("petpos-demo-db", { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return;
      }
      resolve(true);
      return new Promise<never>(() => {});
    });
  });
}
