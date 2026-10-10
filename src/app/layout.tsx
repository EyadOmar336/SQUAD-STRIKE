import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "SQUADSTRIKE — Your Squad. Your Battlefield.",
  description: "Lock in. Squad up. Play fast-paced 3D tactical combat in your browser. Create a room, invite your friends, and deploy on desktop or mobile. لعبة قتال ثلاثية الأبعاد مع الأصدقاء.",
  icons: { icon: "/icon.svg" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: "cover", themeColor: "#101310" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
