import type { Metadata } from "next";
// Fuentes autoalojadas (spec 038, D3): se sirven desde la propia app, sin Google Fonts.
import "@fontsource-variable/inter";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "ContApp",
  description: "ContApp: SIRE, correcciones y buzones SOL para contadores",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
