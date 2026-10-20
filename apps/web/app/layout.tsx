import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NomaanOS — Complaint intelligence",
  description: "A clear foundation for faster, more consistent customer support."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
