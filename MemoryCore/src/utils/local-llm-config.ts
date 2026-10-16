/** Opt-in OpenAI-compatible local inference; does not change service authentication. */
export function localLlmDefaults(input: {
  mode?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): { baseUrl: string; apiKey: string; model: string } | undefined {
  if (input.mode?.trim().toLowerCase() !== "local") return undefined;
  const provider = input.provider?.trim().toLowerCase() || "ollama";
  if (provider !== "ollama" && provider !== "lmstudio") {
    throw new Error("Local LLM provider must be ollama or lmstudio");
  }
  const value = (raw: string | undefined, fallback: string): string =>
    raw?.trim() && raw.trim() !== "REPLACE_ME" ? raw.trim() : fallback;
  return {
    baseUrl: value(input.baseUrl, provider === "ollama"
      ? "http://localhost:11434/v1" : "http://localhost:1234/v1"),
    apiKey: value(input.apiKey, "local-no-key"),
    model: value(input.model, provider === "ollama" ? "qwen2.5:7b" : "local-model"),
  };
}
