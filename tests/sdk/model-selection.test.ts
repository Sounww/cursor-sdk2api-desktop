import { expect, test } from "vitest";
import { cursorModelSelection } from "../../src/sdk/model-selection.js";

test("grok-4.7 xhigh uses reasoning_effort and the accepted 256k context", () => {
  expect(cursorModelSelection("grok-4.7", [{ id: "effort", value: "xhigh" }])).toEqual({
    id: "grok-4.7",
    params: [
      { id: "context", value: "256k" },
      { id: "reasoning_effort", value: "xhigh" },
    ],
  });
});

test("a grok-4.7 variant slug is sent as registry parameters", () => {
  expect(cursorModelSelection("grok-4.7-xhigh-fast")).toEqual({
    id: "grok-4.7",
    params: [
      { id: "context", value: "256k" },
      { id: "fast", value: "true" },
      { id: "reasoning_effort", value: "xhigh" },
    ],
  });
});

test("an explicit grok-4.7 context is preserved", () => {
  expect(
    cursorModelSelection("grok-4.7", [
      { id: "effort", value: "high" },
      { id: "context", value: "500k" },
    ]),
  ).toEqual({
    id: "grok-4.7",
    params: [
      { id: "context", value: "500k" },
      { id: "reasoning_effort", value: "high" },
    ],
  });
});

test("grok-4.6 keeps the effort parameter and its model id", () => {
  expect(cursorModelSelection("grok-4.6", [{ id: "effort", value: "xhigh" }])).toEqual({
    id: "grok-4.6",
    params: [{ id: "effort", value: "xhigh" }],
  });
});

test("bare grok-4.7 without an effort selection sends no parameters", () => {
  expect(cursorModelSelection("grok-4.7")).toEqual({ id: "grok-4.7" });
});
