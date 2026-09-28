import { test } from "node:test";
import assert from "node:assert/strict";
import { samplingParams } from "../src/services/openai.js";

test("gpt-4 usa temperatura; gpt-5 original usa 'minimal'; los nuevos usan 'none'", () => {
  assert.deepEqual(samplingParams("gpt-4o-mini", 0.2), { temperature: 0.2 });
  assert.deepEqual(samplingParams("gpt-4.1-nano", 0), { temperature: 0 });
  assert.deepEqual(samplingParams("gpt-5-nano", 0), { reasoning_effort: "minimal" });
  assert.deepEqual(samplingParams("gpt-5-mini-2025-08-07", 0), { reasoning_effort: "minimal" });
  assert.deepEqual(samplingParams("gpt-5.4-nano", 0), { reasoning_effort: "none" });
  assert.deepEqual(samplingParams("gpt-6-luna", 0), { reasoning_effort: "none" });
});
