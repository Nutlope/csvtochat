"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, resolveChatModel } from "@/lib/models";

export function useLLMModel() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const models = CHAT_MODELS;
  const defaultModel = DEFAULT_CHAT_MODEL.slug;
  const selectedModelSlug =
    resolveChatModel(searchParams.get("model"))?.slug ?? defaultModel;

  const setModel = (model: string) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("model", model);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  return {
    selectedModelSlug,
    setModel,
    models,
    defaultModel,
  };
}
