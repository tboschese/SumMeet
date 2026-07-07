import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SumMeet",
  description: "Turn a meeting recording into a decision record.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
