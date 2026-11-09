import { AuthBowl } from "@/components/auth/AuthBowl";
import { FolderIcon, MessageIcon, SparklesIcon } from "@/components/ui/icons";
import { getT } from "@/i18n/server";

/** The sign-in page's left column from `lg`: the animated bowl, a tagline and what Aquarium is for. */
export async function LoginBrandPanel() {
  const t = await getT("login");
  const points = [
    { icon: MessageIcon, text: t("pointChat") },
    { icon: SparklesIcon, text: t("pointToday") },
    { icon: FolderIcon, text: t("pointFiles") },
  ];
  return (
    <div data-component="LoginBrandPanel" className="flex flex-col gap-8">
      <AuthBowl className="h-[220px] self-start xl:h-[260px]" />
      <p className="text-2xl font-semibold tracking-tight xl:text-[28px]">{t("tagline")}</p>
      <ul className="flex flex-col gap-4">
        {points.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-3 text-[15px] text-[var(--color-muted)]">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-accent)]">
              <Icon size={18} />
            </span>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}
