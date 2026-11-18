import type { ModelRef } from "./service.js";

/** The `labels` option by id then API name, else the configured name, else the id. */
export function labelFor(labels: Record<string, string>, id: string, apiName: string, name?: string): string {
  return labels[id] ?? labels[apiName] ?? (name && name.trim() ? name : id);
}

/** The API name is the model's `id` setting, else its key. */
export function modelsFromConfig(
  models: Record<string, { id?: string; name?: string } | undefined> | undefined,
  labels: Record<string, string>,
): ModelRef[] {
  return Object.entries(models ?? {}).map(([key, model]) => {
    const apiName = model?.id?.trim() || key;
    return { id: key, apiName, label: labelFor(labels, key, apiName, model?.name) };
  });
}
