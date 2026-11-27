import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readOpenRouterRoutes, setOpenRouterRoute } from "./openrouter-routes";

const model = "example/model:free";
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openbot-route-test-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

test("joins prices and training policy for the exact model variant and endpoint", async () => {
  const flight = [
    { provider_slug: "one/fp8", is_free: false, data_policy: { training: true } },
    { provider_slug: "one/fp8", is_free: true, data_policy: { training: false } },
    { provider_slug: "one", is_free: true, data_policy: { training: true } },
    { provider_slug: "unknown", is_free: false, data_policy: { training: false } },
  ];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "https://openrouter.ai/example/model:free")
      return new Response(`1:${JSON.stringify(flight)}\n`, { headers: { "content-type": "text/x-component" } });
    expect(url).toBe("https://openrouter.ai/api/v1/models/example/model:free/endpoints");
    return Response.json({
      data: {
        endpoints: [
          { tag: "one/fp8", pricing: { prompt: "0", completion: "0.0000004" } },
          { tag: "one" },
          { tag: "unknown" },
        ],
      },
    });
  });
  const routes = await Effect.runPromise(readOpenRouterRoutes(model));
  expect(routes.options).toMatchObject([
    { provider: "one/fp8", trainsOnData: false, promptPerMillion: 0 },
    { provider: "one", trainsOnData: true, promptPerMillion: null },
    { provider: "unknown", trainsOnData: null },
  ]);
  expect(routes.options[0]?.completionPerMillion).toBeCloseTo(0.4);
});

test("keeps no-training in Auto and preserves user-owned routing rules", async () => {
  const path = join(directory, "models.json");
  const source = {
    providers: {
      openrouter: {
        modelOverrides: {
          [model]: { compat: { openRouterRouting: { only: ["old"], allow_fallbacks: false, sort: "price" } } },
        },
      },
    },
  };
  await writeFile(path, JSON.stringify(source), "utf8");

  const restricted = await Effect.runPromise(setOpenRouterRoute({ model, provider: null, noTraining: true }));
  expect(restricted).toEqual({ model, current: null, noTraining: true });
  const saved = async () => JSON.parse(await readFile(path, "utf8")).providers.openrouter.modelOverrides;
  expect((await saved())[model].compat.openRouterRouting).toEqual({ data_collection: "deny", sort: "price" });

  const unrestricted = await Effect.runPromise(setOpenRouterRoute({ model, provider: null, noTraining: false }));
  expect(unrestricted).toEqual({ model, current: null, noTraining: false });
  expect((await saved())[model].compat.openRouterRouting).toEqual({ sort: "price" });
});
