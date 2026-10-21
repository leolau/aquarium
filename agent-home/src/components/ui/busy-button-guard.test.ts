/**
 * Guard: a component that sends a change to the server (POST/PUT/PATCH/DELETE)
 * must start it through `ActionButton` or `useAction`, so the button shows it
 * is working and a second click cannot send the request again.
 *
 * PENDING lists the components not converted yet (plan:
 * docs/plans/2026-10-20-busy-buttons-plan.md). Each area PR removes its
 * entries; the list must only shrink.
 */
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");

const PENDING = new Set([
  // PR 2 — Chat, Inbox, To-dos
  "components/chat/ChatPane.tsx",
  "components/chat/Composer.tsx",
  "components/inbox/InboxView.tsx",
  "components/inbox/IncomingDetailView.tsx",
  "components/todos/TodoCompleteForm.tsx",
  "components/todos/TodoDetailView.tsx",
  "components/todos/TodosList.tsx",
  // PR 3 — Projects
  "components/projects/CardActions.tsx",
  "components/projects/CardApprovals.tsx",
  "components/projects/CardEditor.tsx",
  "components/projects/EditBriefSheet.tsx",
  "components/projects/NewProjectForm.tsx",
  "components/projects/ProjectDetailView.tsx",
  "components/projects/ProjectLifecycleMenu.tsx",
  "components/projects/board/NeedsYouCard.tsx",
  "components/projects/board/NeedsYouStrip.tsx",
  "components/projects/board/NewCardForm.tsx",
  "components/projects/inputs/InputRow.tsx",
  "components/projects/outputs/ClosureOffer.tsx",
  "components/projects/outputs/DeliverableCard.tsx",
  "components/projects/panels/BoardPanel.tsx",
  "components/projects/panels/OutputsPanel.tsx",
  "components/projects/panels/PeoplePanel.tsx",
  "components/projects/panels/PlanPanel.tsx",
  "components/projects/panels/SettingsPanel.tsx",
  "components/projects/panels/ToolsPanel.tsx",
  // PR 4 — Settings, People
  "components/settings/ConnectedAccounts.tsx",
  "components/settings/EmailMailboxes.tsx",
  "components/settings/EntityGoalSection.tsx",
  "components/settings/GoogleClientSetup.tsx",
  "components/settings/PersonalMcpServers.tsx",
  "components/settings/RoleLimitsSection.tsx",
  "components/settings/SettingsView.tsx",
  "components/settings/TelegramBotSetup.tsx",
  "components/settings/TelegramLinks.tsx",
  "components/settings/ToolsSettings.tsx",
  "components/settings/VpnConnections.tsx",
  "components/settings/WhatsAppBridges.tsx",
  // PR 5 — Sign-in, first-run, Account, Get ready
  "components/LanguageSwitch.tsx",
  "components/LoginForm.tsx",
  "components/LogoutButton.tsx",
  "components/auth/ResetRequestForm.tsx",
  "components/auth/SetupOwnerForm.tsx",
  "components/get-ready/BackupsItem.tsx",
  "components/get-ready/SecurityBasicsItem.tsx",
  "components/push/PushEnroll.tsx",
  // PR 6 — Files, Memory, Models, other
  "components/coral/LeadChatHost.tsx",
  "components/files/BrowseView.tsx",
  "components/files/NetworkFolders.tsx",
  "components/memory/MemoryView.tsx",
  "components/models/ModelPickerSheet.tsx",
  "components/models/ModelsView.tsx",
  "components/webview/WebviewConsole.tsx",
]);

const SENDS_CHANGE = /method:\s*"(POST|PUT|PATCH|DELETE)"|^\s*method,\s*$|method: method/m;
const USES_BUSY_BUTTON = /from "@\/components\/ui\/ActionButton"|from "@\/lib\/use-action"/;

function componentFiles(): string[] {
  return ["components", "app"].flatMap((dir) =>
    (readdirSync(path.join(SRC, dir), { recursive: true }) as string[])
      .map((f) => path.posix.join(dir, f.split(path.sep).join("/")))
      .filter((f) => f.endsWith(".tsx") && !f.includes(".test.")),
  );
}

describe("busy buttons", () => {
  const files = componentFiles();
  const sending = files.filter((f) => SENDS_CHANGE.test(readFileSync(path.join(SRC, f), "utf8")));

  it("every component that sends a change uses ActionButton / useAction", () => {
    const missing = sending.filter(
      (f) => !PENDING.has(f) && !USES_BUSY_BUTTON.test(readFileSync(path.join(SRC, f), "utf8")),
    );
    expect(missing).toEqual([]);
  });

  it("PENDING only lists components that still need converting", () => {
    const stale = [...PENDING].filter(
      (f) => !sending.includes(f) || USES_BUSY_BUTTON.test(readFileSync(path.join(SRC, f), "utf8")),
    );
    expect(stale).toEqual([]);
  });
});
