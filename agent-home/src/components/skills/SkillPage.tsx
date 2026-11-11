"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { CopyButton, downloadText } from "@/components/skills/CopyButton";
import { projectParam, SkillImprovePanel, type EvidenceProject } from "@/components/skills/SkillImprovePanel";
import { SkillMarkdown } from "@/components/skills/SkillMarkdown";
import { SkillVersionsPanel } from "@/components/skills/SkillVersionsPanel";
import { SkillUsagePanel } from "@/components/skills/SkillUsagePanel";
import { skillHref, skillInitials, skillsListHref } from "@/components/skills/skill-links";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { errorText, profileQuery, sendJson } from "@/lib/admin-fetch";
import { formatSize, lineCount } from "@/lib/skills/editor-state";
import { getBody, parseSkill } from "@/lib/skills/frontmatter";
import { extractHeadings } from "@/lib/skills/outline";
import { useUndoToast } from "@/components/ui/UndoToast";
import { useAction } from "@/lib/use-action";
import { useHydrated } from "@/lib/use-hydrated";
import { ALL_SKILL_PERMISSIONS, type SkillPermissions } from "@/lib/skills/permissions";
import type { SkillDetails, SkillInfo } from "@/types";

type Tab = "instructions" | "files" | "usage" | "versions" | "improve" | "used";
const TABS: readonly Tab[] = ["instructions", "files", "usage", "versions", "improve", "used"];
const isTab = (value: string | undefined): value is Tab => !!value && (TABS as readonly string[]).includes(value);
/** The Skills Lab tabs; they need the `lab` Skills permission. */
const LAB_TABS: readonly Tab[] = ["usage", "versions", "improve"];

export const chipClass =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 py-px text-[11px] text-[var(--color-muted)]";
export const accentChipClass =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] px-2.5 py-px text-[11px] text-[var(--color-accent)]";
export const toolButtonClass =
  "!min-h-9 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-xs hover:border-[var(--color-accent)] disabled:opacity-60";

export function sourceBadge(source: SkillInfo["source"]): string {
  return source === "builtin" ? "built-in" : source === "hub" ? "hub" : "local";
}

function sourceDetail(skill: SkillInfo | null): string {
  if (!skill) return "—";
  if (skill.source === "builtin") return "Built-in · ships with Hermes";
  if (skill.source === "hub") return `Skills hub · ${skill.trust_level || "community"}`;
  return "Local · created in this profile";
}

/** Date of the last SKILL.md change: ISO day on the server, the reader's locale once hydrated. */
export function ChangedDate({ epoch }: { epoch: number }) {
  const hydrated = useHydrated();
  const date = new Date(epoch * 1000);
  const label = hydrated
    ? date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : date.toISOString().slice(0, 10);
  return <time dateTime={date.toISOString()}>{label}</time>;
}

/** The skill page: SKILL.md rendered as a document with its details beside it. */
export function SkillPage({
  name,
  profile,
  content,
  skill,
  details,
  installed,
  initialTab,
  activeVersion,
  permissions = ALL_SKILL_PERMISSIONS,
  project: initialProject = null,
}: {
  name: string;
  profile: string;
  content: string;
  skill: SkillInfo | null;
  details: SkillDetails | null;
  /** Names of every skill in this profile (related skills link only to these). */
  installed: string[];
  /** `?tab=` deep link; unknown values open Instructions. */
  initialTab?: string;
  /** The live version from version history, when there is one. */
  activeVersion?: { n: number; trial: boolean } | null;
  /** Settings → Skills permissions: `manage` adds the edit controls, `lab` the Skills Lab tabs. */
  permissions?: SkillPermissions;
  /** `?project=` — the Skills Lab tabs show this project's runs as the evidence. */
  project?: EvidenceProject | null;
}) {
  const { manage, lab } = permissions;
  const hasTab = (value: string | undefined): value is Tab => isTab(value) && (lab || !LAB_TABS.includes(value));
  const router = useRouter();
  const parsed = useMemo(() => parseSkill(content), [content]);
  const { meta } = parsed;
  const body = useMemo(() => getBody(content), [content]);
  const headings = useMemo(() => extractHeadings(body), [body]);
  const [tab, setTab] = useState<Tab>(hasTab(initialTab) ? initialTab : "instructions");
  const [project, setProject] = useState<EvidenceProject | null>(initialProject);
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  // Stays true after a successful uninstall so the dialog stays locked until the page navigates away.
  const [uninstalled, setUninstalled] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [active, setActive] = useState(headings[0]?.id ?? "");
  const menuRef = useRef<HTMLDivElement>(null);
  const q = profileQuery(profile);
  const scoped = q ? { profile } : {};
  const category = meta.category || skill?.category || "";
  const description = meta.description || skill?.description || "";
  const files = details?.files ?? [];
  const usedBy = details?.used_by ?? [];

  const undo = useUndoToast();
  const applyEnabled = async (next: boolean) => {
    await sendJson("/api/skills/toggle", "PUT", { name, enabled: next, ...scoped });
    setEnabled(next);
    router.refresh();
  };
  const toggle = useAction(async () => {
    setMessage(null);
    const next = !enabled;
    try {
      await applyEnabled(next);
      undo.show(`${name} turned ${next ? "on" : "off"} for new chats`, async () => {
        try {
          await applyEnabled(!next);
        } catch (err) {
          setMessage(errorText(err));
        }
      });
    } catch (err) {
      setMessage(errorText(err));
    }
  });

  async function uninstall() {
    setMessage(null);
    try {
      await sendJson("/api/skills/hub/uninstall", "POST", { name, ...scoped });
      setUninstalled(true);
      router.push(skillsListHref(profile));
      router.refresh();
    } catch (err) {
      setConfirmUninstall(false);
      setMessage(errorText(err));
    }
  }

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menuOpen]);

  // Highlight the outline entry for the section being read.
  useEffect(() => {
    if (tab !== "instructions" || headings.length === 0 || typeof IntersectionObserver === "undefined") return;
    const els = headings.map((h) => document.getElementById(h.id)).filter((el): el is HTMLElement => !!el);
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [headings, tab]);

  /** Switch tabs and keep `?tab=` in the address; false for a tab this page doesn't have. */
  function selectTab(next: string): boolean {
    if (!hasTab(next)) return false;
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "instructions") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    url.hash = "";
    history.replaceState(null, "", url);
    return true;
  }

  /** Drop the `?project=` evidence scope and show runs from everywhere. */
  function clearProject() {
    setProject(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("project");
    history.replaceState(null, "", url);
  }

  function jump(id: string) {
    setActive(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
  }

  const outline = (
    <ul className="space-y-0.5">
      {headings.map((h) => (
        <li key={h.id}>
          <a
            href={`#${h.id}`}
            onClick={(e) => {
              e.preventDefault();
              jump(h.id);
            }}
            className={`block border-l-2 py-1 pr-2 ${h.level === 1 ? "pl-2.5 text-[13px]" : h.level === 2 ? "pl-[22px] text-xs" : "pl-[34px] text-xs"} ${
              active === h.id
                ? "border-[var(--color-accent)] font-medium text-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            }`}
          >
            {h.text}
          </a>
        </li>
      ))}
    </ul>
  );

  const tabButton = (id: Tab, label: string, count?: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => selectTab(id)}
      className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 text-sm ${
        tab === id ? "border-[var(--color-accent)] font-semibold text-[var(--color-fg)]" : "border-transparent text-[var(--color-muted)]"
      }`}
    >
      {label}
      {count ? <span className={chipClass}>{count}</span> : null}
    </button>
  );

  const menuItem = "block w-full px-3.5 text-left text-sm hover:bg-[var(--color-surface-2)]";

  return (
    <section data-component="SkillPage" data-skill={name} className="space-y-2">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-[13px] text-[var(--color-muted)]">
        <Link href={skillsListHref(profile)} className="text-[var(--color-accent)]">
          Skills
        </Link>
        <span aria-hidden>›</span>
        <span>{profile}</span>
        {category ? (
          <>
            <span aria-hidden>›</span>
            <span>{category}</span>
          </>
        ) : null}
        <span aria-hidden>›</span>
        <b aria-current="page" className="font-semibold text-[var(--color-fg)]">
          {name}
        </b>
      </nav>

      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-3.5">
          <div className="flex min-w-0 flex-1 gap-3.5">
            <div
              aria-hidden
              className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[13px] font-bold text-[var(--color-accent)]"
            >
              {skillInitials(name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <h1 className="mr-1 break-all text-xl font-semibold">{name}</h1>
                {activeVersion ? (
                  <span className={chipClass}>{`v${activeVersion.n} · active${activeVersion.trial ? " (trial)" : ""}`}</span>
                ) : meta.version ? (
                  <span className={chipClass}>{`v${meta.version}`}</span>
                ) : null}
                {skill ? <span className={accentChipClass}>{sourceBadge(skill.source)}</span> : null}
              </div>
              {description ? <p className="mt-0.5 text-sm text-[var(--color-muted)]">{description}</p> : null}
              {meta.tags.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {meta.tags.map((t) => (
                    <span key={t} className={chipClass}>
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto">
            {manage ? (
            <>
            <span className="text-xs text-[var(--color-muted)]">Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={`${enabled ? "Disable" : "Enable"} ${name}`}
              disabled={toggle.pending || !skill}
              onClick={() => void toggle.run()}
              className="flex h-11 w-12 shrink-0 items-center justify-center disabled:opacity-60"
            >
              <span className={`relative block h-[22px] w-[38px] rounded-full transition-colors ${enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)]"}`}>
                <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-[var(--color-fg)] transition-all ${enabled ? "left-[19px]" : "left-[3px]"}`} />
              </span>
            </button>
            <Link href={skillHref(name, profile, "edit")} role="button" className={`${toolButtonClass} inline-flex items-center`}>
              ✎ Edit
            </Link>
            </>
            ) : (
              <span data-state={enabled ? "on" : "off"} className={enabled ? accentChipClass : chipClass}>
                {enabled ? "On" : "Off"}
              </span>
            )}
            <div ref={menuRef} className="relative">
              <button
                type="button"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
                className={toolButtonClass}
              >
                ⋯
              </button>
              {menuOpen ? (
                <div role="menu" className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg">
                  {manage ? (
                  <Link role="menuitem" href={skillHref(name, profile, "edit", "view=plain")} className={`${menuItem} flex min-h-11 items-center`}>
                    Edit as plain text
                  </Link>
                  ) : null}
                  <CopyButton text={content} label="Copy SKILL.md" className={menuItem} />
                  <button type="button" role="menuitem" className={menuItem} onClick={() => downloadText("SKILL.md", content)}>
                    Download SKILL.md
                  </button>
                  {manage && skill?.source === "hub" ? (
                    <button
                      type="button"
                      role="menuitem"
                      className={`${menuItem} text-[var(--color-danger)]`}
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirmUninstall(true);
                      }}
                    >
                      Uninstall…
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {message ? (
          <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">
            {message}
          </p>
        ) : null}

        <div role="tablist" aria-label="Skill sections" className="mb-3.5 mt-4 flex gap-0.5 overflow-x-auto border-b border-[var(--color-border)]">
          {tabButton("instructions", "Instructions")}
          {tabButton("files", "Files", details ? String(files.length) : undefined)}
          {lab ? tabButton("usage", "Usage") : null}
          {lab ? tabButton("versions", "Versions") : null}
          {lab ? tabButton("improve", "Improve") : null}
          {tabButton("used", "Used by", details ? `${usedBy.length} ${usedBy.length === 1 ? "profile" : "profiles"}` : undefined)}
        </div>

        {tab === "instructions" ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[200px_minmax(0,1fr)_260px] xl:grid-cols-[220px_minmax(0,1fr)_260px]">
            <nav aria-label="On this page" className="hidden self-start lg:sticky lg:top-20 lg:block">
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--color-muted)]">On this page</div>
              {outline}
            </nav>
            {headings.length > 1 ? (
              <details className="rounded-xl border border-[var(--color-border)] px-3 lg:hidden">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm text-[var(--color-muted)]">On this page</summary>
                <div className="pb-2">{outline}</div>
              </details>
            ) : null}
            <article className="min-w-0 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4 sm:px-6 sm:py-5">
              <SkillMarkdown markdown={body} />
            </article>
            <aside className="flex flex-col gap-3" aria-label="Skill details">
              <div className="rounded-2xl border border-[var(--color-border)] p-3.5">
                <dl className="text-[13px] [&_dd]:mt-0.5 [&_dt:first-child]:mt-0 [&_dt]:mt-2.5 [&_dt]:text-[11px] [&_dt]:uppercase [&_dt]:tracking-wide [&_dt]:text-[var(--color-muted)]">
                  <dt>When the agent uses it</dt>
                  <dd>{description || "—"}</dd>
                  <dt>Source</dt>
                  <dd>{sourceDetail(skill)}</dd>
                  {meta.author || meta.license ? (
                    <>
                      <dt>Author · licence</dt>
                      <dd>{[meta.author, meta.license].filter(Boolean).join(" · ")}</dd>
                    </>
                  ) : null}
                  <dt>Platforms</dt>
                  <dd className="flex flex-wrap gap-1">
                    {meta.platforms.length ? meta.platforms.map((p) => <span key={p} className={chipClass}>{p}</span>) : "All platforms"}
                  </dd>
                  {meta.related_skills.length ? (
                    <>
                      <dt>Related skills</dt>
                      <dd className="flex flex-wrap gap-x-2">
                        {meta.related_skills.map((r) =>
                          installed.includes(r) ? (
                            <Link key={r} href={skillHref(r, profile)} className="text-[var(--color-accent)]">
                              {r}
                            </Link>
                          ) : (
                            <span key={r} title="Not installed in this profile">
                              {r}
                            </span>
                          ),
                        )}
                      </dd>
                    </>
                  ) : null}
                  {category ? (
                    <>
                      <dt>Category</dt>
                      <dd>{category}</dd>
                    </>
                  ) : null}
                  <dt>Last changed</dt>
                  <dd>
                    {details?.modified_at ? <ChangedDate epoch={details.modified_at} /> : "—"} · {lineCount(content)} lines
                  </dd>
                </dl>
              </div>
              {files.length ? (
                <div className="rounded-2xl border border-[var(--color-border)] p-3.5">
                  <h3 className="text-sm font-semibold">Files</h3>
                  <FileTable files={files.slice(0, 6)} />
                  {files.length > 6 ? (
                    <button type="button" className="mt-1 text-xs text-[var(--color-accent)]" onClick={() => setTab("files")}>
                      All {files.length} files
                    </button>
                  ) : null}
                </div>
              ) : null}
            </aside>
          </div>
        ) : tab === "usage" && lab ? (
          <SkillUsagePanel
            name={name}
            profile={profile}
            tabHref={(t) => skillHref(name, profile, "", `tab=${t}${projectParam(project)}`)}
            onOpenTab={selectTab}
            project={project}
            onClearProject={clearProject}
          />
        ) : tab === "versions" && lab ? (
          <SkillVersionsPanel name={name} profile={profile} />
        ) : tab === "files" ? (
          <div className="max-w-2xl">
            {details ? (
              <>
                <p className="mb-2 text-sm text-[var(--color-muted)]">What&apos;s in this skill&apos;s folder. The agent loads SKILL.md; the other files are there for it to read or run when the instructions say so.</p>
                <FileTable files={files} />
                {details.files_truncated ? <p className="mt-2 text-xs text-[var(--color-muted)]">Only the first {files.length} files are listed.</p> : null}
              </>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">The file list couldn&apos;t be loaded.</p>
            )}
          </div>
        ) : tab === "improve" && lab ? (
          <SkillImprovePanel
            name={name}
            profile={profile}
            content={content}
            onOpenTab={selectTab}
            project={project}
            onClearProject={clearProject}
          />
        ) : (
          <div className="max-w-2xl">
            {details ? (
              <>
                <p className="mb-2 text-sm text-[var(--color-muted)]">Profiles that have a skill called {name}. Each profile keeps its own copy.</p>
                <ul className="divide-y divide-[var(--color-border)] rounded-2xl border border-[var(--color-border)]">
                  {usedBy.map((u) => (
                    <li key={u.profile} className="flex items-center gap-2 px-3.5 py-2 text-sm">
                      <Link href={skillHref(name, u.profile)} className="flex min-h-11 flex-1 items-center font-medium">
                        {u.profile}
                        {u.profile === profile ? <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">(this page)</span> : null}
                      </Link>
                      <span className={u.enabled ? accentChipClass : chipClass}>{u.enabled ? "on" : "off"}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">Which profiles use this skill couldn&apos;t be loaded.</p>
            )}
          </div>
        )}
      </div>

      {undo.toast}
      {confirmUninstall ? (
        <ConfirmDialog
          title={`Uninstall ${name}?`}
          body={`This removes the hub skill from profile ${profile}. New chats won't have it; you can install it again from the Skills hub.`}
          confirmLabel="Uninstall"
          busy={uninstalled}
          onConfirm={uninstall}
          onCancel={() => setConfirmUninstall(false)}
        />
      ) : null}
    </section>
  );
}

function FileTable({ files }: { files: SkillDetails["files"] }) {
  return (
    <table className="mt-1.5 w-full border-collapse text-[13px]">
      <tbody>
        {files.map((f) => (
          <tr key={f.path} className="border-b border-[var(--color-border)] last:border-b-0">
            <td className="break-all py-1.5 pr-2 font-mono text-[12.5px]">{f.path}</td>
            <td className="whitespace-nowrap py-1.5 text-right text-xs text-[var(--color-muted)]">{formatSize(f.size)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
