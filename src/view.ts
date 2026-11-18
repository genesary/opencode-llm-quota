/** Text views of a {@link Snapshot}: the `quota` detail and the status line of the selected model. */
import type { ModelView, Snapshot } from "./service.js";

export const TOOL_DESCRIPTION =
  "Show the user's quotas on the AI platform models (normal/low priority, caps, resets). " +
  "Read-only, calls no model. Return the result to the user as is.";

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

function modelBlock(model: ModelView, now: number): string[] {
  const title = model.label === model.apiName ? model.label : `${model.label} (${model.apiName})`;
  switch (model.status) {
    case "pending":
      return [`${title}: reading…`];
    case "no-quota":
      return [`${title}: no quota on this model`];
    case "unavailable":
      return [`${title}: quota unavailable (see "Quota unavailable" in the README)`];
    case "ok":
      return [
        title,
        ...model.detail.map((line) => `  ${line}`),
        ...(model.updatedAt !== undefined ? [`  read ${age(now - model.updatedAt)} ago`] : []),
      ];
  }
}

export function renderDetail(snapshot: Snapshot, now: number = Date.now()): string {
  if (!snapshot.gateway) {
    return "Quota unavailable: no platform provider with a baseURL in the OpenCode config.";
  }
  if (!snapshot.models.length) return `Quotas · ${snapshot.gateway}\nNo model configured for this provider.`;
  const lines = [`Quotas · ${snapshot.gateway}`];
  for (const model of snapshot.models) lines.push(...modelBlock(model, now));
  return lines.join("\n");
}

/** The line of the selected model, when it belongs to the platform provider. */
export function currentLine(
  snapshot: Snapshot,
  current: { providerID: string; modelID: string } | undefined,
  providerId: string,
): string | undefined {
  if (!current || current.providerID !== providerId) return undefined;
  const model = snapshot.models.find((m) => m.id === current.modelID || m.apiName === current.modelID);
  return model?.line;
}
