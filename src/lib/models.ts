export type ChatModel = {
  logo: string;
  title: string;
  model: string;
  slug: string;
  isDefault?: boolean;
  hasReasoning?: boolean;
  contextLength: number;
  // Extra fields sent in the Together chat completion request body
  togetherOptions?: { reasoning?: { enabled: boolean } };
};

export const CHAT_MODELS: ChatModel[] = [
  {
    logo: 'https://cdn.prod.website-files.com/650c3b59079d92475f37b68f/6798c7d11669ad7315d427af_66f41a324f1d713df2cbfbf4_deepseek-logo.webp',
    title: 'DeepSeek V4.1 Flash',
    slug: 'deepseek-v4-1-flash',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    isDefault: true,
    contextLength: 1000000,
    togetherOptions: { reasoning: { enabled: false } },
  },
  {
    logo: 'https://registry.npmmirror.com/@lobehub/icons-static-png/latest/files/light/zhipu-color.png',
    title: 'GLM 5.3',
    slug: 'glm-5-3',
    model: 'zai-org/GLM-5.3',
    contextLength: 1048575,
    togetherOptions: { reasoning: { enabled: false } },
  },
  {
    logo: 'https://registry.npmmirror.com/@lobehub/icons-static-png/latest/files/light/openai.png',
    title: 'GPT OSS 120B',
    model: 'openai/gpt-oss-120b',
    slug: 'gpt-oss-120b',
    hasReasoning: true,
    contextLength: 131072,
  },
];

export const DEFAULT_CHAT_MODEL = CHAT_MODELS.find((m) => m.isDefault)!;

// Slugs of retired models that can still appear in chat URLs (?model=...).
const LEGACY_MODEL_SLUGS = ['qwen-3-coder-480b', 'deepseek-v3', 'llama-3-3'];

// Returns the allowlisted model for a slug, or null for unknown slugs.
export function resolveChatModel(slug?: string | null): ChatModel | null {
  if (!slug || LEGACY_MODEL_SLUGS.includes(slug)) return DEFAULT_CHAT_MODEL;
  return CHAT_MODELS.find((m) => m.slug === slug) ?? null;
}
