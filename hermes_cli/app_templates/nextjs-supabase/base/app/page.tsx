import { APP_NAME } from "@/app.config.mjs";
import { getUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AppHome() {
  const user = await getUser();
  return (
    <main data-component="AppHome" style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>{APP_NAME}</h1>
      <p>{user ? `Signed in as ${user.id}.` : "Not signed in."}</p>
    </main>
  );
}
