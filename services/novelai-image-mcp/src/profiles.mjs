export const UPSTREAM_PROFILES = Object.freeze({
  official: Object.freeze({
    baseUrl: "https://image.novelai.net",
    generatePath: "/ai/generate-image",
    authHeader: "Authorization",
    authPrefix: "Bearer",
    modelFull: "nai-diffusion-4-5-full",
    modelCurated: "nai-diffusion-4-5-curated",
    responseMode: "auto",
    accept: "application/json, image/webp, image/png, image/jpeg, application/zip",
    promptLanguagePolicy: "allow"
  }),
  standard: Object.freeze({
    baseUrl: "",
    generatePath: "/ai/generate-image",
    authHeader: "Authorization",
    authPrefix: "Bearer",
    modelFull: "nai-diffusion-4-5-full",
    modelCurated: "nai-diffusion-4-5-curated",
    responseMode: "auto",
    accept: "application/json, image/webp, image/png, image/jpeg, application/zip",
    promptLanguagePolicy: "allow"
  }),
  custom: Object.freeze({
    baseUrl: "",
    generatePath: "/ai/generate-image",
    authHeader: "Authorization",
    authPrefix: "Bearer",
    modelFull: "nai-diffusion-4-5-full",
    modelCurated: "nai-diffusion-4-5-curated",
    responseMode: "auto",
    accept: "application/json, image/webp, image/png, image/jpeg, application/zip",
    promptLanguagePolicy: "allow"
  })
});

export function normalizeProfileName(value) {
  const name = (value || "standard").trim().toLowerCase();
  if (!Object.hasOwn(UPSTREAM_PROFILES, name)) {
    throw new Error("UPSTREAM_PROFILE must be official, standard, or custom");
  }
  return name;
}

export function resolveProfileSettings(env = process.env) {
  const profileName = normalizeProfileName(env.UPSTREAM_PROFILE);
  const defaults = UPSTREAM_PROFILES[profileName];

  const pick = (name, fallback) => {
    const value = env[name];
    return value === undefined || value.trim() === ""
      ? fallback
      : value.trim();
  };

  return {
    profileName,
    baseUrl: pick("UPSTREAM_BASE_URL", defaults.baseUrl),
    generatePath: pick("UPSTREAM_GENERATE_PATH", defaults.generatePath),
    authHeader: pick("UPSTREAM_AUTH_HEADER", defaults.authHeader),
    authPrefix:
      env.UPSTREAM_AUTH_PREFIX === undefined
        ? defaults.authPrefix
        : env.UPSTREAM_AUTH_PREFIX.trim(),
    modelFull: pick("UPSTREAM_MODEL_FULL", defaults.modelFull),
    modelCurated: pick("UPSTREAM_MODEL_CURATED", defaults.modelCurated),
    responseMode: pick("UPSTREAM_RESPONSE_MODE", defaults.responseMode).toLowerCase(),
    accept: pick("UPSTREAM_ACCEPT", defaults.accept),
    promptLanguagePolicy: pick(
      "PROMPT_LANGUAGE_POLICY",
      defaults.promptLanguagePolicy
    ).toLowerCase()
  };
}
