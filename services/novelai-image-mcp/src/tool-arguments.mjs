const NUMERIC_ARGUMENTS = [
  "seed",
  "steps",
  "guidance",
  "reference_strength",
  "reference_fidelity",
  "user_reference_strength",
  "user_reference_fidelity",
  "vibe_reference_strength",
  "vibe_reference_fidelity"
];

export function normalizeNovelAiToolArguments(rawArgs) {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return rawArgs;

  const normalized = { ...rawArgs };
  for (const name of NUMERIC_ARGUMENTS) {
    const value = normalized[name];
    if (typeof value !== "string" || !value.trim()) continue;
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) normalized[name] = numericValue;
  }
  return normalized;
}
