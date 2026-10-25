import type { ReactNode } from "react";
import { APP_NAME } from "@/app.config.mjs";

export const metadata = { title: APP_NAME };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
