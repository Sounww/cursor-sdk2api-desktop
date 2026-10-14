export interface ModelParameterValue {
  id: string;
  value: string;
}

const GROK_47 = /^(grok-4\.7)(?:-(low|medium|high|xhigh))?(-fast)?$/;

/**
 * Grok 4.7's registry id stays `grok-4.7`. Effort is `reasoning_effort`, not `effort`.
 * The local runtime rejects the advertised 500k default, so an explicit variant
 * selection uses the 256k context that the registry accepts.
 */
export function cursorModelSelection(
  modelId: string,
  params?: readonly ModelParameterValue[],
): { id: string; params?: ModelParameterValue[] } {
  const match = GROK_47.exec(modelId);
  if (!match) {
    return params && params.length > 0 ? { id: modelId, params: [...params] } : { id: modelId };
  }

  const next = new Map((params ?? []).map((param) => [param.id, param.value]));
  const embedded = match[2];
  if (embedded && !next.has("effort") && !next.has("reasoning_effort")) {
    next.set("reasoning_effort", embedded);
  }
  const effort = next.get("effort");
  if (effort !== undefined) {
    next.delete("effort");
    if (!next.has("reasoning_effort")) next.set("reasoning_effort", effort);
  }
  if (match[3]) next.set("fast", "true");
  const selectsVariant = next.has("reasoning_effort") || next.has("fast") || Boolean(match[3]);
  if (selectsVariant && !next.has("context")) next.set("context", "256k");
  if (next.size === 0) return { id: "grok-4.7" };
  return {
    id: "grok-4.7",
    params: [...next.entries()]
      .map(([id, value]) => ({ id, value }))
      .sort((left, right) => left.id.localeCompare(right.id) || left.value.localeCompare(right.value)),
  };
}
