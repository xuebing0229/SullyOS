export const PRECISE_REFERENCE_TYPES = new Set([
  "character",
  "style",
  "character&style"
]);

function round2(value) {
  return Math.round(value * 100) / 100;
}

function finiteUnit(value, name, fallback) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return round2(number);
}

export function isNovelAiV45Model(modelId) {
  return /^nai-diffusion-4-5-(?:full|curated)$/i.test(String(modelId || ""));
}

export function normalizePreciseReference(input) {
  if (!input) return null;
  const type = String(input.type || "character").trim().toLowerCase();
  if (!PRECISE_REFERENCE_TYPES.has(type)) {
    throw new Error("reference_type must be character, style, or character&style");
  }
  if (!Buffer.isBuffer(input.imageBuffer) || input.imageBuffer.length === 0) {
    throw new Error("reference image is missing");
  }
  return {
    type,
    strength: finiteUnit(input.strength, "reference_strength", 0.75),
    fidelity: finiteUnit(input.fidelity, "reference_fidelity", 0.85),
    imageBuffer: input.imageBuffer
  };
}

export function applyPreciseReference(parameters, input) {
  const reference = normalizePreciseReference(input);
  if (!reference) return parameters;

  const imageBase64 = reference.imageBuffer.toString("base64");
  return {
    ...parameters,
    normalize_reference_strength_multiple: false,
    director_reference_images: [imageBase64],
    director_reference_descriptions: [
      {
        caption: {
          base_caption: reference.type,
          char_captions: []
        },
        legacy_uc: false
      }
    ],
    director_reference_information_extracted: [1],
    director_reference_secondary_strength_values: [
      round2(1 - reference.fidelity)
    ],
    director_reference_strength_values: [reference.strength]
  };
}

export function preciseReferenceUnsupportedMessage() {
  return [
    "The upstream rejected the locked-character request.",
    "The configured API station may not pass through NovelAI V4.5 Precise Reference fields.",
    "Confirm that it supports director_reference_* parameters or use the official NovelAI endpoint.",
    "The request was not retried without the reference image."
  ].join(" ");
}
