import type { Metadata } from "next";

import { SetupOwnerForm } from "@/components/auth/SetupOwnerForm";
import type { ProviderOption } from "@/components/LoginForm";
import { MobileShell } from "@/components/MobileShell";
import { HermesApiClient } from "@/lib/api/client";

export const metadata: Metadata = {
  title: "Set up Aquarium",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

export default async function Page() {
  // The sign-in provider "Finish setup" uses; an empty list still lets the
  // owner be created (they then sign in from /login).
  let providers: ProviderOption[] = [];
  try {
    providers = (await new HermesApiClient().authProviders()).providers;
  } catch {
    providers = [];
  }
  return (
    <MobileShell title="Aquarium" showCoral={false} wide>
      <SetupOwnerForm providers={providers} />
    </MobileShell>
  );
}
