import type { ModelProviderInput } from "@deki-ai/shared";

export type BuiltinModelProvider = {
  id: string;
  name: string;
  shortName: string;
  description: {
    zh: string;
    en: string;
  };
  config: Omit<ModelProviderInput, "apiKey">;
};

export const builtinModelProviders: readonly BuiltinModelProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    shortName: "OA",
    description: {
      zh: "GPT 系列，支持文本、图像与推理。",
      en: "GPT models with text, vision, and reasoning.",
    },
    config: {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      models: [
        { id: "gpt-5.4", name: "GPT-5.4", reasoning: true, input: ["text", "image"], contextWindow: 272_000, maxTokens: 128_000 },
        { id: "gpt-5.4-mini", name: "GPT-5.4 mini", reasoning: true, input: ["text", "image"], contextWindow: 400_000, maxTokens: 128_000 },
      ],
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    shortName: "AN",
    description: {
      zh: "Claude 系列，适合复杂推理与长上下文任务。",
      en: "Claude models for complex reasoning and long context.",
    },
    config: {
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      models: [
        { id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000 },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000 },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 64_000 },
      ],
    },
  },
  {
    id: "google",
    name: "Google Gemini",
    shortName: "G",
    description: {
      zh: "Gemini 系列，支持多模态与超长上下文。",
      en: "Gemini models with multimodal and long-context support.",
    },
    config: {
      id: "google",
      name: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      api: "google-generative-ai",
      authHeader: false,
      models: [
        { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
        { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
        { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
      ],
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    shortName: "DS",
    description: {
      zh: "DeepSeek 推理与通用模型，使用中国区 API。",
      en: "DeepSeek reasoning and general models using the China API.",
    },
    config: {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000 },
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 384_000 },
      ],
    },
  },
  {
    id: "moonshotai-cn",
    name: "Moonshot Kimi",
    shortName: "K",
    description: {
      zh: "Kimi 通用与代码模型，使用中国区 API。",
      en: "Kimi general and coding models using the China API.",
    },
    config: {
      id: "moonshotai-cn",
      name: "Moonshot Kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      api: "openai-completions",
      models: [
        { id: "kimi-k3", name: "Kimi K3", reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_072 },
        { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", reasoning: true, input: ["text", "image"], contextWindow: 262_144, maxTokens: 262_144 },
        { id: "kimi-k2.6", name: "Kimi K2.6", reasoning: true, input: ["text", "image"], contextWindow: 262_144, maxTokens: 262_144 },
      ],
    },
  },
  {
    id: "minimax-cn",
    name: "MiniMax",
    shortName: "M",
    description: {
      zh: "MiniMax M 系列，使用中国区 Anthropic 兼容 API。",
      en: "MiniMax M models through the China Anthropic-compatible API.",
    },
    config: {
      id: "minimax-cn",
      name: "MiniMax",
      baseUrl: "https://api.minimaxi.com/anthropic",
      api: "anthropic-messages",
      models: [
        { id: "MiniMax-M3", name: "MiniMax-M3", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000 },
        { id: "MiniMax-M2.7", name: "MiniMax-M2.7", reasoning: true, input: ["text"], contextWindow: 204_800, maxTokens: 131_072 },
        { id: "MiniMax-M2.7-highspeed", name: "MiniMax-M2.7 Highspeed", reasoning: true, input: ["text"], contextWindow: 204_800, maxTokens: 131_072 },
      ],
    },
  },
  {
    id: "zai",
    name: "智谱 GLM",
    shortName: "GLM",
    description: {
      zh: "GLM 通用与视觉模型，使用 Z.ai API。",
      en: "GLM general and vision models through the Z.ai API.",
    },
    config: {
      id: "zai",
      name: "智谱 GLM",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      api: "openai-completions",
      models: [
        { id: "glm-5.2", name: "GLM-5.2", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 131_072 },
        { id: "glm-5.1", name: "GLM-5.1", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 131_072 },
        { id: "glm-5v-turbo", name: "GLM-5V-Turbo", reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 131_072 },
      ],
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    shortName: "OR",
    description: {
      zh: "一个 Key 使用多家模型，内置稳定的 latest 别名。",
      en: "Access multiple model families with one key and stable latest aliases.",
    },
    config: {
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      api: "openai-completions",
      models: [
        { id: "~openai/gpt-latest", name: "OpenAI GPT Latest", reasoning: true, input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000 },
        { id: "~anthropic/claude-sonnet-latest", name: "Anthropic Claude Sonnet Latest", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 128_000 },
        { id: "~google/gemini-flash-latest", name: "Google Gemini Flash Latest", reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 },
        { id: "~moonshotai/kimi-latest", name: "MoonshotAI Kimi Latest", reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_072 },
      ],
    },
  },
] as const;

const builtinProviderIds = new Set(builtinModelProviders.map((provider) => provider.id));

export function isBuiltinModelProvider(id: string): boolean {
  return builtinProviderIds.has(id);
}

export function builtinProviderInput(
  provider: BuiltinModelProvider,
  apiKey: ModelProviderInput["apiKey"],
): ModelProviderInput {
  return {
    ...provider.config,
    apiKey,
  };
}
