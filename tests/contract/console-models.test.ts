import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

test("console model catalog is empty until an account is imported", async () => {
  ctx = await startTestApp({ captureLogs: true });
  const response = await fetch(`${ctx.url}/v0/management/models`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "unavailable",
    reason: "cursor_account_pool_empty",
    models: [],
  });
});

test("console model catalog unions account catalogs without returning Cursor keys", async () => {
  ctx = await startTestApp({
    captureLogs: true,
    config: { stateDir: mkdtempSync(join(tmpdir(), "cursor-sdk2api-models-")) },
    sdk: {
      modelsByApiKey: {
        "alpha-model-aaaa": {
          ok: true,
          models: [
            { id: "grok-4.7", displayName: "Grok 4.7" },
            { id: "claude-sonnet-4-6", displayName: "Sonnet 4.6" },
          ],
        },
        "beta-model-bbbb": {
          ok: true,
          models: [
            { id: "grok-4.7", displayName: "Grok 4.7" },
            { id: "composer-2.5", displayName: "Composer 2.5" },
          ],
        },
      },
    },
  });
  for (const apiKey of ["alpha-model-aaaa", "beta-model-bbbb"]) {
    const created = await fetch(`${ctx.url}/v0/management/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    });
    expect(created.status).toBe(201);
  }

  const response = await fetch(`${ctx.url}/v0/management/models`);
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).not.toContain("alpha-model-aaaa");
  expect(text).not.toContain("beta-model-bbbb");
  const body = JSON.parse(text) as {
    status: string;
    models: Array<{ id: string; display_name?: string; accounts: Array<{ id: string; key_hint: string }> }>;
  };
  expect(body.status).toBe("ok");
  expect(body.models.map((model) => model.id)).toEqual([
    "claude-sonnet-4-6",
    "composer-2.5",
    "grok-4.7",
  ]);
  expect(body.models.find((model) => model.id === "grok-4.7")?.accounts).toEqual([
    { id: expect.any(String), key_hint: "••••aaaa" },
    { id: expect.any(String), key_hint: "••••bbbb" },
  ]);
  expect(body.models.find((model) => model.id === "composer-2.5")?.display_name).toBe("Composer 2.5");
  expect(ctx.logs.join("\n")).not.toContain("alpha-model-aaaa");
  expect(ctx.logs.join("\n")).not.toContain("beta-model-bbbb");
});
