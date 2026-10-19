import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { ChunkErrorListener } from "@/components/ChunkErrorListener";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { ThemeScript } from "@/components/ThemeScript";
import { htmlLang, I18nProvider } from "@/i18n";
import { getLocale, loadMessages } from "@/i18n/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aquarium",
  description: "Mobile-first face for your Hermes agent.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Aquarium",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0d12",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={htmlLang(locale)} data-theme="dark" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body data-component="RootLayout">
        <I18nProvider locale={locale} messages={loadMessages(locale)}>
          {children}
        </I18nProvider>
        <ServiceWorkerRegister />
        <ChunkErrorListener />
      </body>
    </html>
  );
}
