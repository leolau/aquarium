/**
 * Coral — Phase 1 registrations: every current destination of agent-home as
 * an app manifest. This file is the ONLY place navigation destinations are
 * declared; the old PRIMARY_NAV/SECONDARY_NAV split is gone — top-level
 * versus clustered is now a `category` decision.
 *
 * Ordering: top-level petals sort by `order` (clusters by their first
 * member), so the 0–50 band is the top-level arc and 60+ is cluster content.
 */
import { registerApp, registerCluster } from "@/components/coral/coral-registry";

registerCluster("workspace", { label: "Workspace", glyph: "⬡" });
registerCluster("system", { label: "System", glyph: "❖" });

// ── Top-level petals (cap: 8) ──────────────────────────────────────────────

registerApp({
  id: "home",
  name: "Home",
  glyph: "◉",
  kind: "next-route",
  route: "/",
  category: "home",
  order: 0,
});

registerApp({
  id: "todos",
  name: "To-dos",
  glyph: "◎",
  hint: "What needs you",
  kind: "next-route",
  route: "/todos",
  category: "tasks",
  order: 10,
  badgeSlot: "todos-open",
});

registerApp({
  id: "chat",
  name: "Chat",
  glyph: "✦",
  hint: "One-brain chat",
  kind: "next-route",
  route: "/chat",
  category: "chat",
  order: 20,
  badgeSlot: "chat-unread",
});

registerApp({
  id: "inbox",
  name: "Inbox",
  glyph: "✉",
  hint: "Everything that arrived",
  kind: "next-route",
  route: "/inbox",
  category: "inbox",
  order: 30,
});

registerApp({
  id: "memory",
  name: "Memory",
  glyph: "◇",
  hint: "What it remembers",
  kind: "next-route",
  route: "/memory",
  category: "memory",
  order: 40,
});

registerApp({
  id: "projects",
  name: "Projects",
  glyph: "▦",
  hint: "What runs on its own",
  kind: "next-route",
  route: "/projects",
  category: "projects",
  order: 50,
});

// ── Workspace cluster ──────────────────────────────────────────────────────

registerApp({
  id: "files",
  name: "Files",
  glyph: "▤",
  hint: "Everything that arrived",
  kind: "next-route",
  route: "/files",
  category: "workspace",
  order: 60,
});

registerApp({
  id: "activity",
  name: "Activity",
  glyph: "≋",
  hint: "Interaction traces",
  kind: "next-route",
  route: "/activity",
  category: "workspace",
  order: 70,
});

registerApp({
  id: "graph",
  name: "Graph",
  glyph: "◈",
  hint: "GTS Centre",
  kind: "next-route",
  route: "/graph",
  category: "workspace",
  order: 80,
});

registerApp({
  id: "capacity",
  name: "Capacity",
  glyph: "◱",
  hint: "Headroom on this box",
  kind: "next-route",
  route: "/capacity",
  category: "workspace",
  order: 90,
});

// ── System cluster ─────────────────────────────────────────────────────────

registerApp({
  id: "users",
  name: "Users",
  glyph: "☰",
  hint: "Directory + enrolment",
  kind: "next-route",
  route: "/users",
  category: "system",
  order: 100,
});

registerApp({
  id: "suggestions",
  name: "Suggestions",
  glyph: "⇲",
  hint: "Proposed sub-goals",
  kind: "next-route",
  route: "/profiles/suggestions",
  category: "system",
  order: 110,
});

registerApp({
  id: "tools",
  name: "Tools",
  glyph: "⚙",
  hint: "Apps the agent built",
  kind: "next-route",
  route: "/tools",
  category: "system",
  order: 120,
});

registerApp({
  id: "models",
  name: "Models",
  glyph: "◆",
  hint: "Brains per slot",
  kind: "next-route",
  route: "/models",
  category: "system",
  order: 125,
});

registerApp({
  id: "core",
  name: "Core area",
  glyph: "▣",
  hint: "C7 boundary",
  kind: "next-route",
  route: "/core",
  category: "system",
  order: 130,
});

registerApp({
  id: "webview",
  name: "Agent webview",
  glyph: "◔",
  hint: "FG-17b CDP",
  kind: "next-route",
  route: "/webview",
  category: "system",
  order: 140,
});

registerApp({
  id: "settings",
  name: "Settings",
  glyph: "⛭",
  hint: "Theme + preferences",
  kind: "next-route",
  route: "/settings",
  category: "system",
  order: 150,
});

registerApp({
  id: "onboarding",
  name: "Getting started",
  glyph: "◐",
  hint: "FG-15 readiness",
  kind: "next-route",
  route: "/onboarding",
  category: "system",
  order: 160,
});
