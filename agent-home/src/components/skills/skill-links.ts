import { profileQuery } from "@/lib/admin-fetch";

/** `/skills/<name>[/edit]?profile=…` (the default profile needs no query). */
export function skillHref(name: string, profile: string, sub: "" | "edit" = "", extra = ""): string {
  const q = [profileQuery(profile), extra].filter(Boolean).join("&");
  return `/skills/${encodeURIComponent(name)}${sub ? `/${sub}` : ""}${q ? `?${q}` : ""}`;
}

export function skillsListHref(profile: string): string {
  const q = profileQuery(profile);
  return `/skills${q ? `?${q}` : ""}`;
}

/** Up to three letters for the header tile, e.g. `ocr-and-documents` → `OCR`. */
export function skillInitials(name: string): string {
  return (name.replace(/[^a-z0-9]/gi, "").slice(0, 3) || "?").toUpperCase();
}
