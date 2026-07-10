"use client";

// Renders the insight sections the user picked, in the order they picked them
// (SPEC A5). A section with no content is skipped rather than shown empty.

import type { MeetingInsights } from "@summeet/core/schemas";
import type { SectionKey } from "@summeet/core/sections";
import { useT, type TFunction } from "@/lib/i18n";

const PRIORITY: Record<string, string> = {
  high: "bg-red-50 text-red-700",
  medium: "bg-amber-50 text-amber-700",
  low: "bg-neutral-100 text-neutral-600",
};

/** The diarization (A1) marks the recorder's own commitments as owner "You". */
export function isMine(owner: string | null): boolean {
  return !!owner && /^(you|voc[eê])$/i.test(owner.trim());
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-soft/60">
        {title}
      </h2>
      {children}
    </section>
  );
}

function QuoteLink({
  quote,
  onQuote,
}: {
  quote: string | null;
  onQuote: (q: string | null) => void;
}) {
  const t = useT();
  if (!quote) return null;
  return (
    <button
      type="button"
      onClick={() => onQuote(quote)}
      className="mt-1 block text-left text-xs text-brand hover:underline"
      title={t("detail.jumpToQuote")}
    >
      “{quote.length > 90 ? `${quote.slice(0, 90)}…` : quote}”
    </button>
  );
}

const Card = ({ children }: { children: React.ReactNode }) => (
  <li className="rounded-lg border border-brand-light/60 bg-white p-3">{children}</li>
);

function ActionItemList({
  items,
  onQuote,
}: {
  items: MeetingInsights["actionItems"];
  onQuote: (q: string | null) => void;
}) {
  const t = useT();
  return (
    <ul className="space-y-3">
      {items.map((a, i) => (
        <Card key={i}>
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-medium text-ink">{a.task}</p>
            {a.priority && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  PRIORITY[a.priority] ?? ""
                }`}
              >
                {a.priority}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-ink-soft/70">
            {`${t("insight.owner")}: ${a.owner ?? t("insight.none")}`}
            {a.dueDate ? ` · ${t("insight.due")}: ${a.dueDate}` : ""}
          </p>
          <QuoteLink quote={a.sourceQuote} onQuote={onQuote} />
        </Card>
      ))}
    </ul>
  );
}

/** Returns null when the section has nothing to show. */
function renderSection(
  key: SectionKey,
  d: MeetingInsights,
  onQuote: (q: string | null) => void,
  t: TFunction,
): React.ReactNode {
  const label = t(`section.${key}`);

  switch (key) {
    case "tldr":
      return d.tldr ? (
        <section key={key}>
          <p className="text-lg font-medium leading-relaxed text-ink">{d.tldr}</p>
        </section>
      ) : null;

    case "executiveSummary":
      return d.executiveSummary ? (
        <Section key={key} title={label}>
          <p className="text-sm leading-relaxed text-ink-soft">{d.executiveSummary}</p>
        </Section>
      ) : null;

    case "keyPoints":
      return d.keyPoints.length ? (
        <Section key={key} title={label}>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {d.keyPoints.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </Section>
      ) : null;

    case "myCommitments": {
      const mine = d.actionItems.filter((a) => isMine(a.owner));
      return mine.length ? (
        <Section key={key} title={label}>
          <ActionItemList items={mine} onQuote={onQuote} />
        </Section>
      ) : null;
    }

    case "actionItems":
      return d.actionItems.length ? (
        <Section key={key} title={label}>
          <ActionItemList items={d.actionItems} onQuote={onQuote} />
        </Section>
      ) : null;

    case "decisions":
      return d.decisions.length ? (
        <Section key={key} title={label}>
          <ul className="space-y-3">
            {d.decisions.map((dec, i) => (
              <Card key={i}>
                <p className="text-sm font-medium text-ink">{dec.decision}</p>
                {dec.rationale && (
                  <p className="mt-1 text-xs text-ink-soft/70">{t("insight.why")}: {dec.rationale}</p>
                )}
                <QuoteLink quote={dec.sourceQuote} onQuote={onQuote} />
              </Card>
            ))}
          </ul>
        </Section>
      ) : null;

    case "openQuestions":
      return d.openQuestions.length ? (
        <Section key={key} title={label}>
          <ul className="space-y-3">
            {d.openQuestions.map((q, i) => (
              <Card key={i}>
                <p className="text-sm font-medium text-ink">{q.question}</p>
                {q.askedBy && (
                  <p className="mt-1 text-xs text-ink-soft/70">{t("insight.askedBy")}: {q.askedBy}</p>
                )}
                <QuoteLink quote={q.sourceQuote} onQuote={onQuote} />
              </Card>
            ))}
          </ul>
        </Section>
      ) : null;

    case "risks":
      return d.risks.length ? (
        <Section key={key} title={label}>
          <ul className="space-y-3">
            {d.risks.map((r, i) => (
              <Card key={i}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-ink">{r.risk}</p>
                  {r.severity && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                        PRIORITY[r.severity] ?? ""
                      }`}
                    >
                      {r.severity}
                    </span>
                  )}
                </div>
                <QuoteLink quote={r.sourceQuote} onQuote={onQuote} />
              </Card>
            ))}
          </ul>
        </Section>
      ) : null;

    case "nextSteps":
      return d.nextSteps.length ? (
        <Section key={key} title={label}>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
            {d.nextSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </Section>
      ) : null;

    case "metrics":
      return d.metrics.length ? (
        <Section key={key} title={label}>
          <ul className="space-y-2">
            {d.metrics.map((m, i) => (
              <li key={i} className="flex items-baseline gap-2 text-sm">
                <span className="font-semibold text-brand">{m.value}</span>
                <span className="text-ink-soft">{m.label}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null;

    case "topics":
      return d.topics.length ? (
        <Section key={key} title={label}>
          <ul className="space-y-2">
            {d.topics.map((topic, i) => (
              <li key={i}>
                <p className="text-sm font-medium text-ink">{topic.title}</p>
                <p className="text-sm text-ink-soft">{topic.summary}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null;
  }
}

export function InsightSections({
  data,
  sections,
  onQuote,
}: {
  data: MeetingInsights;
  sections: SectionKey[];
  onQuote: (q: string | null) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-10">
      {sections.map((key) => renderSection(key, data, onQuote, t))}
    </div>
  );
}
