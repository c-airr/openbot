import type { ClientAgentModelOption } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { cheapestCompactModel, isGptModel } from "./compact-model";

function fakeModel(
  partial: Partial<ClientAgentModelOption> & { id: string; provider: ClientAgentModelOption["provider"] },
): ClientAgentModelOption {
  return {
    name: partial.id,
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
    ...partial,
  };
}

describe("compact-model", () => {
  it("strictly identifies GPT / Codex / OpenAI models", () => {
    expect(isGptModel(fakeModel({ id: "gpt-4o", provider: "codex" }))).toBe(true);
    expect(isGptModel(fakeModel({ id: "gpt-6-luna", provider: "codex" }))).toBe(true);
    expect(isGptModel(fakeModel({ id: "o1-mini", provider: "codex" }))).toBe(true);
    expect(isGptModel(fakeModel({ id: "o3-mini", provider: "codex" }))).toBe(true);
    expect(isGptModel(fakeModel({ id: "openai/gpt-4o-mini", provider: "openrouter" }))).toBe(true);
    expect(isGptModel(fakeModel({ id: "gemini-3.8-flash", provider: "antigravity" }))).toBe(false);
    expect(isGptModel(fakeModel({ id: "nvidia/nemotron-3.5-super-vl:free", provider: "openrouter" }))).toBe(false);
  });

  it("prefers Gemini and OpenRouter over GPT models", () => {
    const models = [
      fakeModel({ id: "gpt-6-luna", name: "GPT-6 Luna", provider: "codex" }),
      fakeModel({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "antigravity" }),
    ];
    const pick = cheapestCompactModel(models, null);
    expect(pick?.model.id).toBe("gemini-3.8-flash");
    expect(pick?.model.provider).toBe("antigravity");
    expect(pick?.reasoningEffort).toBe("medium");
  });

  it("falls back to OpenRouter Nemotron when Gemini is absent", () => {
    const models = [
      fakeModel({ id: "gpt-4o", name: "GPT-4o", provider: "codex" }),
      fakeModel({ id: "nvidia/nemotron-3.5-super-vl:free", name: "Nemotron 3.5 Super VL", provider: "openrouter" }),
    ];
    const pick = cheapestCompactModel(models, null);
    expect(pick?.model.id).toBe("nvidia/nemotron-3.5-super-vl:free");
    expect(pick?.model.provider).toBe("openrouter");
  });

  it("returns null when only GPT models are available", () => {
    const models = [
      fakeModel({ id: "gpt-4o", name: "GPT-4o", provider: "codex" }),
      fakeModel({ id: "gpt-6-luna", name: "GPT-6 Luna", provider: "codex" }),
    ];
    expect(cheapestCompactModel(models, null)).toBeNull();
  });
});
