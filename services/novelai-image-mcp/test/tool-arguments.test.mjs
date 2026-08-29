import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNovelAiToolArguments } from "../src/tool-arguments.mjs";

test("normalizes numeric strings emitted by tool-calling models", () => {
  assert.deepEqual(normalizeNovelAiToolArguments({
    prompt: "2boys",
    seed: "123",
    steps: "28",
    guidance: "5.5",
    reference_strength: "0.75",
    reference_fidelity: "0.85",
    user_reference_strength: "0.65",
    user_reference_fidelity: "0.8"
  }), {
    prompt: "2boys",
    seed: 123,
    steps: 28,
    guidance: 5.5,
    reference_strength: 0.75,
    reference_fidelity: 0.85,
    user_reference_strength: 0.65,
    user_reference_fidelity: 0.8
  });
});

test("leaves invalid and unrelated strings for schema validation", () => {
  const rawArgs = { prompt: "2boys", steps: "many", guidance: "", model: "full" };
  assert.deepEqual(normalizeNovelAiToolArguments(rawArgs), rawArgs);
});
