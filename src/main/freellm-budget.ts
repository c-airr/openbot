// Fork: the FreeLLMAPI budget for the rail. Only for a computer that has
// `openbot-freellmapi-v1.json` ({ "url": "http://host:3001", "apiKey": "...", "chain": "code" }) in the app data
// folder; there is no setting for it, so other installs never show it. The key stays in that file.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FreeLlmBudget } from "@openbot/contracts/ipc";
import { Option, Schema } from "effect";
import { app } from "electron";

const CONFIG_FILE = "openbot-freellmapi-v1.json";
const TIMEOUT_MS = 10_000;

/** `chain`: the chain whose models show, as `auto:<chain>` routes them; without it the active chain. */
const Config = Schema.Struct({
  url: Schema.NonEmptyString,
  apiKey: Schema.NonEmptyString,
  chain: Schema.optionalKey(Schema.NonEmptyString),
});

const Count = Schema.NullOr(Schema.Finite);
const Row = Schema.Struct({
  platforma: Schema.String,
  tokenyDzien: Count,
  tokenyDzis: Schema.Finite,
  tokenyZostalo: Count,
});
const Budget = Schema.Struct({
  lancuch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  resetAt: Schema.String,
  dostawcy: Schema.Array(Row),
  modele: Schema.Array(
    Schema.Struct({
      ...Row.fields,
      nazwa: Schema.String,
      modelId: Schema.String,
      rank: Count,
      zapytaniaDzien: Count,
      zapytaniaDzis: Schema.Finite,
      zapytaniaZostalo: Count,
      rodzaj: Schema.Literals(["oficjalny", "nauczony", "szacunek"]),
    }),
  ),
});

const SOURCE = { oficjalny: "official", nauczony: "learned", szacunek: "estimate" } as const;

async function readConfig() {
  const text = await readFile(join(app.getPath("userData"), CONFIG_FILE), "utf8").catch(() => null);
  return text === null ? null : Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(Config))(text));
}

const provider = (row: typeof Row.Type) => ({
  platform: row.platforma,
  tokensPerDay: row.tokenyDzien,
  tokensToday: row.tokenyDzis,
  tokensLeft: row.tokenyZostalo,
});

/** Null without the config file. A server that does not answer is an error, so the rail keeps its last reading. */
export async function readFreeLlmBudget(): Promise<FreeLlmBudget | null> {
  const config = await readConfig();
  if (!config) return null;
  const url = new URL("/v1/budzet", config.url);
  if (config.chain) url.searchParams.set("lancuch", config.chain);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`FreeLLMAPI budget returned HTTP ${response.status}.`);
  const body = Schema.decodeUnknownSync(Budget)(await response.json());
  return {
    chain: body.lancuch ?? null,
    resetsAt: Date.parse(body.resetAt) / 1_000,
    providers: body.dostawcy.map(provider),
    models: body.modele.map((model) => ({
      ...provider(model),
      name: model.nazwa,
      modelId: model.modelId,
      rank: model.rank,
      requestsPerDay: model.zapytaniaDzien,
      requestsToday: model.zapytaniaDzis,
      requestsLeft: model.zapytaniaZostalo,
      source: SOURCE[model.rodzaj],
    })),
  };
}
