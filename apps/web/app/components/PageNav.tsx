"use client";

// A consistent top nav for the app's peer pages (Ask, My work, Settings), so you can move
// between them from anywhere instead of bouncing through the meetings list every time. The
// home page is the hub and keeps its own header; these three sit under it.

import Link from "next/link";
import { useT } from "@/lib/i18n";

type NavKey = "ask" | "commitments" | "settings";

const PEERS: { key: NavKey; href: string; labelKey: "ask.link" | "work.link" | "common.settings" }[] = [
  { key: "ask", href: "/ask", labelKey: "ask.link" },
  { key: "commitments", href: "/commitments", labelKey: "work.link" },
  { key: "settings", href: "/settings", labelKey: "common.settings" },
];

export function PageNav({ current }: { current: NavKey }) {
  const t = useT();
  return (
    <nav className="mb-6 flex flex-wrap items-center gap-1 text-sm">
      <Link
        href="/"
        className="rounded-md px-2.5 py-1.5 text-ink-soft/70 hover:bg-brand-tint hover:text-brand"
      >
        {t("common.backToMeetings")}
      </Link>
      <span className="mx-0.5 text-ink-soft/25">·</span>
      {PEERS.map((p) => (
        <Link
          key={p.key}
          href={p.href}
          aria-current={current === p.key ? "page" : undefined}
          className={`rounded-md px-2.5 py-1.5 ${
            current === p.key
              ? "bg-brand-tint font-medium text-brand"
              : "text-ink-soft/70 hover:bg-brand-tint hover:text-brand"
          }`}
        >
          {t(p.labelKey)}
        </Link>
      ))}
    </nav>
  );
}
