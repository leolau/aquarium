import { describe, expect, it } from "vitest";

import { passwordProviderOrder } from "./password-providers";

const supabase = { name: "supabase", display_name: "Email & Password (Supabase)", supports_password: true };
const basic = { name: "basic", display_name: "Username & Password", supports_password: true };
const oauth = { name: "github", display_name: "GitHub", supports_password: false };

describe("passwordProviderOrder", () => {
  it("prefers the email provider for an address and the username one otherwise", () => {
    expect(passwordProviderOrder("o@x.io", [basic, supabase])).toEqual(["supabase", "basic"]);
    expect(passwordProviderOrder("admin", [supabase, basic])).toEqual(["basic", "supabase"]);
  });

  it("only ever offers password providers, and at most one fallback", () => {
    const another = { name: "ldap", display_name: "Directory", supports_password: true };
    expect(passwordProviderOrder("admin", [oauth, supabase, basic, another])).toEqual(["basic", "supabase"]);
    expect(passwordProviderOrder("admin", [oauth, supabase])).toEqual(["supabase"]);
    expect(passwordProviderOrder("admin", [oauth])).toEqual([]);
  });

  it("recognises a username provider by its label when the name is unfamiliar", () => {
    const named = { name: "local", display_name: "Username & Password", supports_password: true };
    expect(passwordProviderOrder("admin", [supabase, named])).toEqual(["local", "supabase"]);
  });
});
