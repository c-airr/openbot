import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentStore } from "../src/backend/agent-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const root = await mkdtemp(join(tmpdir(), "openbot-chat-capacity-"));
const state = join(root, "state");
const home = join(root, "home");
const database = new OpenBotDatabase(state);
const store = new AgentStore(state, home, database);
let reopenedDatabase: OpenBotDatabase | undefined;
const report: { passed: boolean; count?: number; error?: string } = { passed: false };
try {
  await runCauseEffect(store.initialize());
  for (let index = 0; index < 101; index++) {
    await runCauseEffect(
      store.createAgent({ name: `Chat ${index}`, description: "", avatarSeed: "chat", avatarHue: null }),
    );
  }
  const helper = await runCauseEffect(
    store.createAgent({
      name: "Compact helper",
      description: "compact:1 parent:example",
      avatarSeed: "chat",
      avatarHue: null,
    }),
  );
  reopenedDatabase = new OpenBotDatabase(state);
  const reopened = new AgentStore(state, home, reopenedDatabase);
  await runCauseEffect(reopened.initialize());
  assert.equal(reopened.list().length, 102);
  assert.ok(reopened.list().some((agent) => agent.id === helper.id));
  report.passed = true;
  report.count = reopened.list().length;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  reopenedDatabase?.close();
  database.close();
  await rm(root, { recursive: true, force: true });
  const out = resolve(import.meta.dirname, "..", ".openbot-build", "chat-capacity-e2e");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
if (!report.passed) {
  process.stderr.write(`${report.error}\n`);
  process.exitCode = 1;
}
