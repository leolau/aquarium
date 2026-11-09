import { redirect } from "next/navigation";

import { AuthBowl } from "@/components/auth/AuthBowl";
import { AuthCard, AuthLayout } from "@/components/auth/AuthLayout";
import { LoginBrandPanel } from "@/components/auth/LoginBrandPanel";
import { ResetRequestForm } from "@/components/auth/ResetRequestForm";
import { LoginForm, type ProviderOption } from "@/components/LoginForm";
import { getT } from "@/i18n/server";
import { HermesApiClient, HermesApiError } from "@/lib/api/client";
import { getPrincipal } from "@/lib/auth/principal";

export const dynamic = "force-dynamic";

/** Login page for the C1 bridge; already-authenticated sessions skip to `/`. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ profile?: string }>;
}) {
  if (await getPrincipal()) {
    redirect("/");
  }

  const t = await getT("login");
  let providers: ProviderOption[] = [];
  try {
    const res = await new HermesApiClient().authProviders();
    providers = res.providers;
  } catch (err) {
    // Login is still usable if the AI layer exposes a default password
    // provider; surface nothing here beyond an empty list.
    if (!(err instanceof HermesApiError)) {
      providers = [];
    }
  }

  const profile = (await searchParams).profile?.trim() || undefined;

  return (
    <AuthLayout component="LoginPage" aside={<LoginBrandPanel />}>
      <AuthCard className="gap-5">
        <div className="flex flex-col gap-3">
          <AuthBowl className="h-[120px] self-start lg:hidden" />
          <h1 className="text-[26px] font-semibold tracking-tight lg:text-3xl">{t("title")}</h1>
          <p className="text-sm text-[var(--color-muted)]">{t("intro")}</p>
        </div>
        <LoginForm providers={providers} profile={profile} />
        {/* Self-service recovery: a locked-out user cannot sign in to ask, and
         * nobody hands out temporary passwords by hand any more. */}
        <ResetRequestForm profile={profile} />
      </AuthCard>
    </AuthLayout>
  );
}
