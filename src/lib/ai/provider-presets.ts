export type TranscriptionStyle = "whisper" | "chat" | "gemini" | "elevenlabs";

export interface ProviderPreset {
    name: string;
    baseUrl: string;
    placeholder: string;
    defaultModel: string;
    transcriptionStyle: TranscriptionStyle;
    fetchAudioModels?: boolean;
    knownTranscriptionModels?: readonly string[];
    /**
     * Whether this provider can be used for AI enhancements (summaries,
     * titles) via `chat.completions`. Defaults to `true` when omitted --
     * only transcription-only providers (e.g. ElevenLabs Scribe) set this
     * to `false`.
     */
    supportsEnhancement?: boolean;
    /**
     * Lightweight chat model for enhancements when the stored credential
     * model is a transcription id (or unset). Required wherever `whisper-*`
     * is the default model, because `gpt-4o-mini` is not served by every
     * provider; falls back to `gpt-4o-mini` when omitted.
     */
    enhancementModel?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
    {
        name: "OpenAI",
        baseUrl: "",
        placeholder: "sk-...",
        defaultModel: "whisper-1",
        transcriptionStyle: "whisper",
        knownTranscriptionModels: [
            "whisper-1",
            "gpt-4o-transcribe",
            "gpt-4o-mini-transcribe",
            "gpt-4o-transcribe-diarize",
        ],
    },
    {
        name: "Groq",
        baseUrl: "https://api.groq.com/openai/v1",
        placeholder: "gsk_...",
        defaultModel: "whisper-large-v3-turbo",
        transcriptionStyle: "whisper",
        // Groq dropped the llama-3.x ids; gpt-oss-20b answers with an empty
        // completion (reasoning budget), qwen3.8-27b returns plain text.
        enhancementModel: "qwen/qwen3.8-27b",
        knownTranscriptionModels: [
            "whisper-large-v3-turbo",
            "whisper-large-v3",
        ],
    },
    {
        name: "Together AI",
        baseUrl: "https://api.together.xyz/v1",
        placeholder: "...",
        defaultModel: "openai/whisper-large-v3",
        transcriptionStyle: "whisper",
        knownTranscriptionModels: [
            "openai/whisper-large-v3",
            "nvidia/parakeet-tdt-0.6b-v3",
        ],
    },
    {
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        placeholder: "sk-or-...",
        defaultModel: "google/gemini-2.5-flash-lite",
        transcriptionStyle: "chat",
        fetchAudioModels: true,
    },
    {
        name: "LM Studio",
        baseUrl: "http://localhost:1234/v1",
        placeholder: "lm-studio",
        defaultModel: "",
        transcriptionStyle: "whisper",
    },
    {
        name: "Ollama",
        baseUrl: "http://localhost:11434/v1",
        placeholder: "ollama",
        defaultModel: "",
        transcriptionStyle: "whisper",
    },
    {
        name: "Google Gemini",
        baseUrl: "",
        placeholder: "AIza...",
        defaultModel: "gemini-2.0-flash",
        transcriptionStyle: "gemini",
        knownTranscriptionModels: [
            "gemini-2.0-flash",
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-1.5-flash",
            "gemini-1.5-pro",
        ],
    },
    {
        name: "ElevenLabs",
        baseUrl: "https://api.elevenlabs.io/v1",
        placeholder: "sk_...",
        defaultModel: "scribe_v2",
        transcriptionStyle: "elevenlabs",
        knownTranscriptionModels: ["scribe_v2", "scribe_v1"],
        supportsEnhancement: false,
    },
    {
        name: "Custom",
        baseUrl: "",
        placeholder: "Your API key",
        defaultModel: "",
        transcriptionStyle: "whisper",
    },
] as const;

export const LOCAL_PRESET_NAMES: ReadonlySet<string> = new Set([
    "LM Studio",
    "Ollama",
]);

export function getVisiblePresets({
    isHosted,
}: {
    isHosted: boolean;
}): readonly ProviderPreset[] {
    if (!isHosted) return PROVIDER_PRESETS;
    return PROVIDER_PRESETS.filter((p) => !LOCAL_PRESET_NAMES.has(p.name));
}

export function findPreset(name: string): ProviderPreset | undefined {
    return PROVIDER_PRESETS.find((p) => p.name === name);
}

export function isLocalPreset(name: string): boolean {
    return LOCAL_PRESET_NAMES.has(name);
}

export function getTranscriptionStyle(
    providerName: string,
): TranscriptionStyle {
    return findPreset(providerName)?.transcriptionStyle ?? "whisper";
}

/**
 * Transcription route for a concrete model. A preset's style is the default
 * for its chat/audio model, but OpenRouter also serves Whisper on
 * `/audio/transcriptions`, so a transcription id there takes the "whisper"
 * route instead of chat completions.
 */
export function getTranscriptionStyleForModel(
    providerName: string,
    model: string | null | undefined,
): TranscriptionStyle {
    const style = getTranscriptionStyle(providerName);
    if (style !== "chat" || !model) return style;
    return /whisper|parakeet|scribe/i.test(model) ? "whisper" : style;
}

/**
 * Whether a provider can run AI enhancements (summaries, titles) via
 * `chat.completions`. Unknown/custom provider names default to `true`.
 */
export function supportsEnhancement(providerName: string): boolean {
    return findPreset(providerName)?.supportsEnhancement ?? true;
}

/**
 * Model for `chat.completions` (titles, summaries). A credential whose model
 * is a transcription id (whisper/parakeet/scribe) or unset needs a provider
 * chat model; `gpt-4o-mini` is only a safe last resort for OpenAI and
 * OpenAI-compatible proxies.
 */
export function resolveEnhancementModel(
    providerName: string,
    model: string | null | undefined,
): string {
    if (model && !/whisper|parakeet|scribe/i.test(model)) return model;
    return findPreset(providerName)?.enhancementModel ?? "gpt-4o-mini";
}
