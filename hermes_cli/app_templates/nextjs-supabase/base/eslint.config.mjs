import { dirname } from "path";
import { fileURLToPath } from "url";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { FlatCompat } from "@eslint/eslintrc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

// Secret values must never be exposed to the browser: Next.js inlines every
// NEXT_PUBLIC_* variable into the client bundle.
const NO_PUBLIC_SECRETS = {
  selector:
    "MemberExpression[property.name=/^NEXT_PUBLIC_.*(SECRET|SERVICE_ROLE|PASSWORD|TOKEN|DATABASE_URL)/]",
  message: "Secret values must not use a NEXT_PUBLIC_ name (it ships to the browser).",
};

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "**/*.d.mts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...compat.extends("next/core-web-vitals"),
  {
    languageOptions: { ecmaVersion: 2023 },
    rules: { "no-restricted-syntax": ["error", NO_PUBLIC_SECRETS] },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", Request: "readonly", Response: "readonly", console: "readonly" },
    },
  },
];

export default config;
