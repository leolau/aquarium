/**
 * Where the landing composer hands a sent message over to the chat page:
 * a fresh conversation whose first turn is `text`, in the session's profile.
 */
export function chatHandOffUrl(text: string): string {
  const q = new URLSearchParams({ new: "1", autosend: "1", draft: text });
  return `/chat?${q.toString()}`;
}

/** Greeting for the local hour (0–23). */
export function greetingFor(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
