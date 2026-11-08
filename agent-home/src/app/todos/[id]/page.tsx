import { notFound } from "next/navigation";

import { MobileShell } from "@/components/MobileShell";
import { TodoDetailView } from "@/components/todos/TodoDetailView";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import type { TodoDetail } from "@/types";

// The to-do is C2-scoped, so it is read per request under the live principal.
export const dynamic = "force-dynamic";

/**
 * `/todos/:id` — one to-do, the arrival behind it, and its full history.
 *
 * An upstream 404 covers both "no such to-do" and "not yours"; this page
 * renders the same not-found either way rather than confirming that somebody
 * else's to-do exists.
 */
/** Only a To-dos query string is a valid Back target (no open redirects). */
function todosBackHref(from: string | string[] | undefined): string {
  const value = Array.isArray(from) ? from[0] : from;
  return value && value.startsWith("?") && !value.includes("//") ? `/todos${value}` : "/todos";
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ from?: string | string[] }>;
}) {
  await requirePrincipal();
  const { id } = await params;

  // The fetch is kept outside the JSX so a render error cannot be mistaken
  // for a missing to-do and turned into a 404.
  let todo: TodoDetail;
  try {
    const client = await apiClientForRequest();
    todo = await client.todo(id);
  } catch {
    notFound();
  }

  return (
    <MobileShell
      title={todo.title}
      back={{ href: todosBackHref((await searchParams)?.from), label: "To-dos" }}
    >
      <TodoDetailView todo={todo} />
    </MobileShell>
  );
}
