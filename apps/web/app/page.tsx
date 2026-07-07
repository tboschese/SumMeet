// Meeting-list shell (Session 0). No data fetching or recorder logic yet —
// those arrive in Sessions 3–5. This is just the empty-state skeleton.

export default function HomePage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SumMeet</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Your meetings, as decision records.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white opacity-60"
            title="Coming in a later session"
          >
            Record
          </button>
          <button
            type="button"
            disabled
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 opacity-60"
            title="Coming in a later session"
          >
            Upload
          </button>
        </div>
      </header>

      <section>
        <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-12 text-center">
          <p className="text-sm font-medium text-neutral-700">No meetings yet</p>
          <p className="mt-1 text-sm text-neutral-500">
            Record or upload a meeting to see its insights here.
          </p>
        </div>
      </section>
    </main>
  );
}
