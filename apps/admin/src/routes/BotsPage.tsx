import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type BotStrategyRow, type BotStrategyStatus } from "../lib/api";
import { STARTER_DEFINITION, STRATEGY_KEY_PATTERN } from "../lib/botTemplate";

interface FormState {
  id: string | null; // null = creating
  key: string;
  name: string;
  description: string;
  definitionText: string;
}

const emptyForm = (): FormState => ({
  id: null,
  key: "",
  name: "",
  description: "",
  definitionText: JSON.stringify(STARTER_DEFINITION, null, 2),
});

const fromRow = (r: BotStrategyRow): FormState => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  definitionText: JSON.stringify(r.definition, null, 2),
});

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

function StatusPill({ status }: { status: BotStrategyStatus }) {
  return <span className={`pill pill--${status.toLowerCase()}`}>{status}</span>;
}

export function BotsPage() {
  const [strategies, setStrategies] = useState<BotStrategyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listBotStrategies()
      .then(setStrategies)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function changeStatus(s: BotStrategyRow, next: BotStrategyStatus) {
    if (next === "PUBLISHED") {
      const ok = window.confirm(
        `Publish "${s.name}"?\n\nEvery user will be able to choose it. Each user sets their own stake and risk limits and turns it on against their own Deriv account; you never see or control their bot.`,
      );
      if (!ok) return;
    }
    if (next === "ARCHIVED") {
      const ok = window.confirm(`Archive "${s.name}"?\n\nNew bots can't use it. Bots already running on it keep running.`);
      if (!ok) return;
    }
    run(() => api.setBotStrategyStatus(s.id, next));
  }

  function remove(s: BotStrategyRow) {
    if (!window.confirm(`Delete "${s.name}"? This can't be undone. A strategy any user has used can only be archived.`)) return;
    run(() => api.deleteBotStrategy(s.id));
  }

  async function save() {
    if (!form) return;
    setError(null);

    if (!form.id && !STRATEGY_KEY_PATTERN.test(form.key)) {
      setError('Key must be lowercase words joined by hyphens, e.g. "ema-rsi-macd-martingale".');
      return;
    }
    let definition: unknown;
    try {
      definition = JSON.parse(form.definitionText);
    } catch {
      setError("Definition isn't valid JSON — check for a missing comma or bracket.");
      return;
    }

    setSaving(true);
    try {
      if (form.id) {
        await api.updateBotStrategy(form.id, { name: form.name, description: form.description, definition });
      } else {
        await api.createBotStrategy({ key: form.key, name: form.name, description: form.description, definition });
      }
      setForm(null);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ marginTop: 0, fontSize: 17 }}>Bot strategies</h1>
        {!form && (
          <button className="button button--inline" onClick={() => setForm(emptyForm())}>
            New strategy
          </button>
        )}
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: -4, marginBottom: 16 }}>
        The catalog users pick from. A strategy is a template only: each user chooses their own stake and stop-loss and starts it on their own
        account. This console can't see, start, stop, or trade any user's bot.
      </p>

      {error && (
        <div role="alert" className="error-text">
          {error}
        </div>
      )}

      {form ? (
        <div>
          <h2 style={{ fontSize: 14, marginTop: 0 }}>{form.id ? "Edit strategy" : "New strategy"}</h2>
          <div className="field">
            <label htmlFor="bot-key">Key</label>
            <input
              id="bot-key"
              value={form.key}
              disabled={form.id !== null}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              placeholder="ema-rsi-macd-martingale"
              className="mono"
            />
            {form.id && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>The key can't change after creation.</span>}
          </div>
          <div className="field">
            <label htmlFor="bot-name">Name</label>
            <input id="bot-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bot-desc">Description shown to users</label>
            <textarea id="bot-desc" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bot-def">Definition (JSON)</label>
            <textarea
              id="bot-def"
              className="mono"
              spellCheck={false}
              value={form.definitionText}
              onChange={(e) => setForm({ ...form, definitionText: e.target.value })}
            />
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Indicators (SMA, EMA, RSI, MACD), entry rules, staking, risk limits, trade duration. The server checks every field when you save.
              New strategies start as Draft.
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="button button--inline" disabled={saving || !form.name || !form.description} onClick={save}>
              {saving ? "Saving…" : form.id ? "Save changes" : "Create draft"}
            </button>
            <button
              className="button button--inline button--ghost"
              disabled={saving}
              onClick={() => {
                setForm(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : strategies.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No strategies yet. Create one to make it available to users once published.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
              <th style={{ padding: "6px 0" }}>Strategy</th>
              <th>Status</th>
              <th>Updated</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => (
              <tr key={s.id} style={{ borderTop: "1px solid var(--border)", verticalAlign: "top" }}>
                <td style={{ padding: "8px 12px 8px 0" }}>
                  <div style={{ fontWeight: 600 }}>{s.name}</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {s.key}
                  </div>
                </td>
                <td style={{ padding: "8px 0" }}>
                  <StatusPill status={s.status} />
                </td>
                <td className="mono" style={{ padding: "8px 0" }}>
                  {new Date(s.updatedAt).toLocaleDateString()}
                </td>
                <td style={{ padding: "8px 0", textAlign: "right" }}>
                  <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button className="button button--inline button--ghost" onClick={() => setForm(fromRow(s))}>
                      Edit
                    </button>
                    {s.status !== "PUBLISHED" && (
                      <button className="button button--inline" onClick={() => changeStatus(s, "PUBLISHED")}>
                        Publish
                      </button>
                    )}
                    {s.status === "PUBLISHED" && (
                      <button className="button button--inline button--ghost" onClick={() => changeStatus(s, "ARCHIVED")}>
                        Archive
                      </button>
                    )}
                    {s.status === "ARCHIVED" && (
                      <button className="button button--inline button--ghost" onClick={() => changeStatus(s, "DRAFT")}>
                        Move to draft
                      </button>
                    )}
                    {s.status === "DRAFT" && (
                      <button className="button button--inline button--danger" onClick={() => remove(s)}>
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
