import type { AccountUsage } from "../ipc-agent-status";
import { isDynamicRecord } from "../runtime-values";
import type { TeamProtocolV8BaseJsonValue } from "./v8-base";
import { decodeTeamProtocolV2Json } from "./webrtc-framing";

export { isUsageRoute } from "./usage-tertiary-v1";

export const TEAM_USAGE_READ_FAILED_CAPABILITY = "usage-read-failed-v1";

export function usageWithoutReadFailed(usage: AccountUsage): AccountUsage {
  return usage.limits.some((limit) => limit.readFailed === true)
    ? { ...usage, limits: usage.limits.filter((limit) => limit.readFailed !== true) }
    : usage;
}

export function usageEventWithoutReadFailed(usage: AccountUsage): AccountUsage | null {
  const sent = usageWithoutReadFailed(usage);
  return sent.limits.length === 0 && usage.limits.length > 0 ? null : sent;
}

export function withUsageReadFailed(
  projected: TeamProtocolV8BaseJsonValue,
  source: unknown,
  sending = false,
): TeamProtocolV8BaseJsonValue {
  if (!isDynamicRecord(projected) || !Array.isArray(projected.limits)) return projected;
  if (!isDynamicRecord(source) || !Array.isArray(source.limits)) return projected;
  const sourceLimits: unknown[] = source.limits;
  const limits = projected.limits.map((limit, index) => {
    const from = sourceLimits[index];
    if (!isDynamicRecord(limit) || !isDynamicRecord(from) || from.readFailed === undefined) return limit;
    if (from.id !== limit.id) return limit;
    if (from.readFailed === true && limit.primary === null && limit.secondary === null)
      return { ...limit, readFailed: true };
    if (sending) return limit;
    throw new Error("Invalid usage read state.");
  });
  return { ...projected, limits };
}

export function withUsageEventReadFailed(
  projected: TeamProtocolV8BaseJsonValue,
  source: unknown,
  sending = false,
): TeamProtocolV8BaseJsonValue {
  if (!isDynamicRecord(projected) || projected.type !== "usage-changed" || !isDynamicRecord(source)) return projected;
  if (projected.usage === undefined) return projected;
  return { ...projected, usage: withUsageReadFailed(projected.usage, source.usage, sending) };
}

export function addUsageEventReadFailed(event: unknown, source: unknown): void {
  if (!isDynamicRecord(event) || event.type !== "usage-changed" || !isDynamicRecord(source)) return;
  if (!isDynamicRecord(event.usage)) return;
  const updated = withUsageReadFailed(decodeTeamProtocolV2Json(event.usage), source.usage);
  if (isDynamicRecord(updated)) Object.assign(event.usage, updated);
}

export function addUsageReadFailed(usage: unknown, source: unknown): void {
  if (!isDynamicRecord(usage)) return;
  const updated = withUsageReadFailed(decodeTeamProtocolV2Json(usage), source);
  if (isDynamicRecord(updated)) Object.assign(usage, updated);
}

export function encodeUsageEventReadFailed(encoded: string, source: unknown): string {
  return JSON.stringify(withUsageEventReadFailed(JSON.parse(encoded), source, true));
}
