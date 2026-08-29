import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPreciseReference,
  isNovelAiV45Model,
  normalizePreciseReference
} from "../src/precise-reference.mjs";

test("builds the NovelAI director_reference parameter shape", () => {
  const parameters = applyPreciseReference(
    { width: 1024, height: 1024 },
    {
      imageBuffer: Buffer.from("png"),
      type: "character",
      strength: 0.75,
      fidelity: 0.85
    }
  );

  assert.equal(parameters.normalize_reference_strength_multiple, false);
  assert.deepEqual(parameters.director_reference_strength_values, [0.75]);
  assert.deepEqual(
    parameters.director_reference_secondary_strength_values,
    [0.15]
  );
  assert.deepEqual(parameters.director_reference_information_extracted, [1]);
  assert.equal(
    parameters.director_reference_descriptions[0].caption.base_caption,
    "character"
  );
  assert.deepEqual(
    parameters.director_reference_descriptions[0].caption.char_captions,
    []
  );
  assert.equal(
    parameters.director_reference_images[0],
    Buffer.from("png").toString("base64")
  );
});

test("keeps two reference images and their settings aligned", () => {
  const parameters = applyPreciseReference(
    { width: 1024, height: 1024 },
    [
      { imageBuffer: Buffer.from("character"), type: "character", strength: 0.75, fidelity: 0.85 },
      { imageBuffer: Buffer.from("user"), type: "character&style", strength: 0.6, fidelity: 0.7 }
    ]
  );

  assert.deepEqual(parameters.director_reference_images, [
    Buffer.from("character").toString("base64"),
    Buffer.from("user").toString("base64")
  ]);
  assert.deepEqual(parameters.director_reference_descriptions.map(item => item.caption.base_caption), ["character", "character&style"]);
  assert.deepEqual(parameters.director_reference_information_extracted, [1, 1]);
  assert.deepEqual(parameters.director_reference_strength_values, [0.75, 0.6]);
  assert.deepEqual(parameters.director_reference_secondary_strength_values, [0.15, 0.3]);
});

test("validates type and unit interval", () => {
  assert.throws(() =>
    normalizePreciseReference({
      imageBuffer: Buffer.from("x"),
      type: "unknown"
    })
  );
  assert.throws(() =>
    normalizePreciseReference({
      imageBuffer: Buffer.from("x"),
      strength: 1.1
    })
  );
});

test("accepts only exact V4.5 Full and Curated model ids", () => {
  assert.equal(isNovelAiV45Model("nai-diffusion-4-5-full"), true);
  assert.equal(isNovelAiV45Model("nai-diffusion-4-5-curated"), true);
  assert.equal(isNovelAiV45Model("nai-diffusion-4-full"), false);
});
