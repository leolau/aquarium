"use client";

import { useSyncExternalStore } from "react";

/**
 * Strings for Settings -> App limits / App storage / GitHub (FG-33 P8-2
 * 2.10), English and 繁中. Kept here, not in tools.json, so the parallel
 * Tools-page PR owns that file alone.
 */
const en = {
  title: "Apps",
  intro: "Limits, storage and source control for the apps people build here. Owner and admins only.",
  loading: "Loading…",
  unavailable: "Not available on this box yet: {detail}",
  saved: "Saved.",
  save: "Save",
  saving: "Saving…",
  reset: "Back to defaults",
  limitsTitle: "App limits",
  limitsIntro: "Defaults for everyone. Per-person exceptions stay on the member's page.",
  tierMember: "Members",
  tierAdmin: "Admins",
  adminTierOwnerOnly: "Only the owner can change the admins' limits.",
  perApp: "Per app",
  perMember: "Per person",
  defaultIs: "default {value}",
  "per_app.memory_high_mb": "Memory soft limit (MB)",
  "per_app.memory_max_mb": "Memory hard limit (MB)",
  "per_app.cpu_quota_pct": "CPU (% of one core)",
  "per_app.disk_mb": "Disk (MB)",
  "per_app.db_mb": "Database (MB)",
  "per_app.db_connections": "Database connections",
  "per_member.apps_registered": "Apps",
  "per_member.apps_running": "Apps running at once",
  "per_member.ram_mb": "Memory (MB)",
  "per_member.disk_mb": "Disk (MB)",
  "per_member.db_mb": "Database (MB)",
  "per_member.external_apps": "External apps",
  storageTitle: "App storage",
  storageIntro: "Where app source, releases, the apps database and build caches live. New apps are refused when free space here drops below the floor.",
  storagePath: "Storage location",
  storageMinFree: "Free space to keep (MB)",
  storageFree: "Free now: {free} MB",
  storageFreeUnknown: "Free space: not measurable yet (the folder does not exist).",
  storageMoveNote: "The location can only move while no apps live there.",
  githubTitle: "GitHub",
  githubIntro: "With a token, every app's source is pushed to a private GitHub repo. Without one it stays in local git on this box.",
  githubOwner: "GitHub account or organisation",
  githubToken: "Token",
  githubTokenPlaceholder: "Paste a new token to replace",
  githubTokenSet: "Set (ends in {last4})",
  githubTokenUnset: "Not set",
  githubBoxGit: "No token: use this box's own git login",
  githubRemove: "Forget token",
  githubRemoving: "Forgetting…",
  "mode.token": "Source is pushed to GitHub with the token.",
  "mode.box-git": "Source is pushed with this box's git login.",
  "mode.local-only": "Source stays in local git only.",
} as const;

export type AppsSettingsKey = keyof typeof en;

const zhHant: Record<AppsSettingsKey, string> = {
  title: "應用程式",
  intro: "這裡建立的應用程式的上限、儲存位置和原始碼管理。只限擁有者和管理員。",
  loading: "載入中…",
  unavailable: "此主機暫未提供：{detail}",
  saved: "已儲存。",
  save: "儲存",
  saving: "儲存中…",
  reset: "還原預設",
  limitsTitle: "應用程式上限",
  limitsIntro: "所有人的預設值。個別成員的例外仍在該成員的頁面設定。",
  tierMember: "成員",
  tierAdmin: "管理員",
  adminTierOwnerOnly: "只有擁有者可以更改管理員的上限。",
  perApp: "每個應用程式",
  perMember: "每人",
  defaultIs: "預設 {value}",
  "per_app.memory_high_mb": "記憶體軟上限（MB）",
  "per_app.memory_max_mb": "記憶體硬上限（MB）",
  "per_app.cpu_quota_pct": "CPU（單核百分比）",
  "per_app.disk_mb": "磁碟（MB）",
  "per_app.db_mb": "資料庫（MB）",
  "per_app.db_connections": "資料庫連線數",
  "per_member.apps_registered": "應用程式數量",
  "per_member.apps_running": "同時運行的應用程式",
  "per_member.ram_mb": "記憶體（MB）",
  "per_member.disk_mb": "磁碟（MB）",
  "per_member.db_mb": "資料庫（MB）",
  "per_member.external_apps": "外部應用程式",
  storageTitle: "應用程式儲存位置",
  storageIntro: "應用程式原始碼、版本、應用程式資料庫和建置快取的存放位置。可用空間低於下限時，不會再接受新的應用程式。",
  storagePath: "儲存位置",
  storageMinFree: "保留可用空間（MB）",
  storageFree: "目前可用：{free} MB",
  storageFreeUnknown: "可用空間：暫時無法量度（資料夾尚未建立）。",
  storageMoveNote: "只有在該位置沒有應用程式時才能搬移。",
  githubTitle: "GitHub",
  githubIntro: "設定權杖後，每個應用程式的原始碼都會推送到私人 GitHub 儲存庫；否則只保留在此主機的本機 git。",
  githubOwner: "GitHub 帳戶或機構",
  githubToken: "權杖",
  githubTokenPlaceholder: "貼上新權杖以取代",
  githubTokenSet: "已設定（結尾為 {last4}）",
  githubTokenUnset: "未設定",
  githubBoxGit: "沒有權杖時：使用此主機自己的 git 登入",
  githubRemove: "移除權杖",
  githubRemoving: "移除中…",
  "mode.token": "原始碼會以權杖推送到 GitHub。",
  "mode.box-git": "原始碼會以此主機的 git 登入推送。",
  "mode.local-only": "原始碼只保留在本機 git。",
};

export const APPS_SETTINGS_MESSAGES: Record<"en" | "zh-Hant", Record<AppsSettingsKey, string>> = {
  en,
  "zh-Hant": zhHant,
};

type Vars = Record<string, string | number>;

function detect(): "en" | "zh-Hant" {
  if (typeof document === "undefined") return "en";
  const tags = [document.documentElement.lang, ...(navigator.languages ?? [])];
  return tags.some((t) => /^zh/i.test(t ?? "")) ? "zh-Hant" : "en";
}

function format(template: string, vars?: Vars): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars && k in vars ? String(vars[k]) : `{${k}}`,
  );
}

const noSubscribe = () => () => {};

export function useAppsSettingsT(): (key: AppsSettingsKey, vars?: Vars) => string {
  const lang = useSyncExternalStore(noSubscribe, detect, () => "en" as const);
  return (key, vars) => format(APPS_SETTINGS_MESSAGES[lang][key] ?? en[key], vars);
}
