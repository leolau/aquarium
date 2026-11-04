import type { ModelProviderOption } from "@/types";

export interface ModelChoice {
  value: string;
  label: string;
  provider: string;
  model: string;
}

/** Flatten provider options into one select list (`provider::model` values). */
export function modelChoices(
  providers: ModelProviderOption[],
  current?: { provider: string | null; model: string | null },
): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const p of providers) {
    for (const m of p.models) {
      out.push({ value: `${p.slug}::${m}`, label: `${p.name} · ${m}`, provider: p.slug, model: m });
    }
  }
  if (current?.provider && current.model) {
    const value = `${current.provider}::${current.model}`;
    if (!out.some((c) => c.value === value)) {
      out.unshift({ value, label: `${current.provider} · ${current.model}`, provider: current.provider, model: current.model });
    }
  }
  return out;
}

export function choiceValue(provider: string | null, model: string | null): string {
  return provider && model ? `${provider}::${model}` : "";
}
