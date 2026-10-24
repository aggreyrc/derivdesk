interface PlaceholderProps {
  title: string;
  note: string;
}

function Placeholder({ title, note }: PlaceholderProps) {
  return (
    <div className="card">
      <h1 style={{ marginTop: 0, fontSize: 18 }}>{title}</h1>
      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>{note}</p>
    </div>
  );
}

export function DashboardPage() {
  return (
    <Placeholder
      title="Dashboard"
      note="Live markets and your watchlist are now on the Markets page. This page becomes the aggregated account summary — positions, P/L, recent activity — once Phase 5 (trading) adds those."
    />
  );
}

export function SettingsPage() {
  return <Placeholder title="Settings" note="Application preferences." />;
}
