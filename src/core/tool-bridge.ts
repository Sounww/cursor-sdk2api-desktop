import { digestJson } from "../digest.js";
import type { Clock } from "../clock.js";
import type { SdkCustomTool, SdkCustomToolResult, SdkToolContent } from "../sdk/port.js";
import { formatContinuationAside, type ContinuationAside } from "../protocols/anthropic/parse.js";
import type { AnthropicTool } from "../protocols/anthropic/types.js";
import type { Session } from "./session.js";

export function mapClientTools(
  tools: AnthropicTool[],
  session: Session,
  clock: Clock,
  onExecute: (session: Session) => void,
  completedResults?: Map<string, SdkCustomToolResult[]>,
): Record<string, SdkCustomTool> {
  const mapped: Record<string, SdkCustomTool> = {};
  for (const tool of tools) {
    mapped[tool.sdk_name ?? tool.name] = {
      description: tool.description,
      inputSchema: tool.input_schema,
      async execute(args, context) {
        const completed = completedResults?.get(completedToolSignature(tool.name, args));
        const replay = completed?.shift();
        if (replay !== undefined) return replay;
        const call = session.createPending(
          tool.name,
          args,
          clock,
          context.toolCallId,
          tool.tool_kind,
          tool.namespace,
        );
        onExecute(session);
        if (session.pump) session.pump.notifyTool(call);
        else session.earlyCalls.push(call);
        return call.promise;
      },
    };
  }
  return mapped;
}

export function completedToolSignature(name: string, input: unknown): string {
  return digestJson({ name, input: input ?? {} });
}

export function resultDigest(toolUseId: string, content: string, isError: boolean): string {
  return digestJson({ tool_use_id: toolUseId, content, is_error: isError });
}

/** Deliver a client tool result. An aside is attached once, on the last result of the batch. */
export function toSdkToolResult(
  result: { content: string; isError: boolean },
  aside?: ContinuationAside,
): SdkCustomToolResult {
  const note = aside ? formatContinuationAside(aside) : "";
  const images = aside?.images ?? [];
  if (!note && images.length === 0) {
    return result.isError
      ? { content: [{ type: "text", text: result.content }], isError: true }
      : result.content;
  }
  const content: SdkToolContent[] = [];
  if (result.content) content.push({ type: "text", text: result.content });
  if (note) content.push({ type: "text", text: note });
  for (const image of images) {
    content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return result.isError ? { content, isError: true } : { content };
}

export function batchDigest(
  results: Array<{ toolUseId: string; content: string; isError: boolean }>,
  aside?: { text: string; images: Array<{ data: string; mimeType: string }> },
): string {
  const body = [...results]
    .sort((a, b) => a.toolUseId.localeCompare(b.toolUseId))
    .map((result) => ({
      tool_use_id: result.toolUseId,
      digest: resultDigest(result.toolUseId, result.content, result.isError),
    }));
  if (!aside || (!aside.text && aside.images.length === 0)) return digestJson(body);
  return digestJson({
    results: body,
    aside: {
      text: aside.text,
      images: aside.images.map((image) => ({ mimeType: image.mimeType, data: image.data })),
    },
  });
}
