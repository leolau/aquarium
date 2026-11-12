/** Test fixtures for the Triage card (GET /api/triage/status shapes). */
import type { TriageKindStatus, TriageStatus } from "@/types";

const LINKS: Record<TriageKindStatus["kind"], TriageKindStatus["setup_links"]> = {
  email: [
    { label: "Mailboxes", href: "/settings/in-out" },
    { label: "Connect Google", href: "/settings/in-out/google" },
  ],
  whatsapp: [{ label: "WhatsApp bridges", href: "/settings/in-out" }],
  calendar: [
    { label: "Connected accounts", href: "/settings/in-out" },
    { label: "Connect Google", href: "/settings/in-out/google" },
  ],
};
const LABEL = { email: "Email", whatsapp: "WhatsApp", calendar: "Calendar" } as const;
export const DIR = "/opt/data/skills";

export function kind(k: TriageKindStatus["kind"], status: TriageKindStatus["status"], missing: TriageKindStatus["missing"] = []): TriageKindStatus {
  const folder = `${DIR}/${k}-triage`;
  return {
    kind: k,
    label: LABEL[k],
    status,
    missing,
    accounts: [],
    skills_present: true,
    skills: [
      {
        name: `${k}-triage`,
        path: folder,
        layer: "base",
        present: true,
        files: ["SKILL.md", "escalation-rules.md"].map((n) => ({ name: n, path: `${folder}/${n}`, present: true })),
      },
    ],
    skills_source: `custom/skills/${k}-triage`,
    config: { path: "/opt/data/x/config.json", present: true },
    credentials_checked: true,
    setup_links: LINKS[k],
    services: [],
  };
}

export const status = (kinds: TriageKindStatus[], can_edit = true, profile: string | null = "hr"): TriageStatus => ({ profile, kinds, can_edit });
