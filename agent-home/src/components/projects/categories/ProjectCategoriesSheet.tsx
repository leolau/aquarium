"use client";

import type { ProjectCategory } from "@/types";

export interface ProjectCategoriesSheetProps {
  /** The current categories, in column order. */
  categories: ProjectCategory[];
  /** Close without (further) changes. Never called mid-write. */
  onClose: () => void;
  /** Called after every successful create/rename/delete with the fresh list. */
  onChanged: (next: ProjectCategory[]) => void;
}

/**
 * Bottom sheet to add, rename, recolour and delete project categories.
 * CONTRACT STUB — implemented by the category-management workstream.
 */
export function ProjectCategoriesSheet(_props: ProjectCategoriesSheetProps) {
  return null;
}
