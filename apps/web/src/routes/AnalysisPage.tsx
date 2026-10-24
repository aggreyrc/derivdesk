import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { api, ApiError } from "../lib/api";
import { useDerivStatus } from "../lib/derivStatus";
import type { ActiveSymbol } from "../lib/marketTypes";
import type { AnalyticsPeriod, BreakdownRow, PerformanceData, Summary, TechnicalData } from "../lib/analyticsTypes";

const PERIODS: Array<{ label: string; value: AnalyticsPeriod }> = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "90 days", value: "90d" },
  { label: "All (max 2000 trades)", value: "all" },
];

const GRANULARITIES = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "1h", seconds: 3600 },
  { label: "1d", seconds: 86400 },
];

const CHART_BASE = {
  layout: { background: { color: "transparent" }, textColor: "#8b93a3" },
  grid: { vertLines: { color: "#232a36" }, horzLines: { color: "#232a36" } },
  rightPriceScale: { borderColor: "#232a36" },
  timeScale: { borderColor: "#232a36", timeVisible: true },
} as const;

function fmt(n: number | null | undefined, decimals: number): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(decimals);
}
function signed(n: number | null | undefined, decimals: number): string {
  if (n === null || n === undefined) return "—";
  return (n > 0 ? "+" : "") + n.toFixed(decimals);
}
function pnlColor(n: number | null | undefined): string | undefined {
  if (n === null || n === undefined || n === 0) return undefined;
  return n > 0 ? "var(--positive)" : "var(--negative)";
}
function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function Tile({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <div style={{ padding: "10px 14px", border: "1px solid var(--border)", borderRadius: 8, minWidth: 130 }} title={hint}>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</div>
      <div className="numeric" style={{ fontSize: 18, fontWeight: 600, color }}>
        {value}
      </div>
    </div>
  );
}

function SummaryTiles({ s, d, currency }: { s: Summary; d: number; currency: string }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
      <Tile label={`Net P/L (${currency})`} value={signed(s.netPnl, d)} color={pnlColor(s.netPnl)} />
      <Tile label="Trades" value={String(s.tradesCount)} hint={`${s.wins} wins · ${s.losses} losses · ${s.breakeven} breakeven`} />
      <Tile label="Win rate" value={pct(s.winRate)} hint="Wins ÷ all trades (breakeven counted in the total)" />
      <Tile label="Profit factor" value={s.profitFactor === null ? "—" : s.profitFactor.toFixed(2)} hint="Gross profit ÷ gross loss. Blank when there are no losses." />
      <Tile label="Expectancy / trade" value={signed(s.expectancy, d)} color={pnlColor(s.expectancy)} />
      <Tile label="Average win" value={fmt(s.averageWin, d)} color={pnlColor(s.averageWin)} />
      <Tile label="Average loss" value={fmt(s.averageLoss, d)} color={pnlColor(s.averageLoss)} />
      <Tile label="Largest win" value={fmt(s.largestWin, d)} color={pnlColor(s.largestWin)} />
      <Tile label="Largest loss" value={fmt(s.largestLoss, d)} color={pnlColor(s.largestLoss)} />
      <Tile label="Total staked" value={fmt(s.totalStaked, d)} />
      <Tile label="Max drawdown" value={fmt(s.maxDrawdown, d)} hint="Largest fall from a running peak of cumulative P/L" />
      <Tile label="Longest streaks" value={`${s.maxConsecutiveWins}W / ${s.maxConsecutiveLosses}L`} />
    </div>
  );
}

function Breakdown({ title, rows, d }: { title: string; rows: BreakdownRow[]; d: number }) {
  return (
    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
      <h3 style={{ fontSize: 13, margin: "0 0 6px" }}>{title}</h3>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>No data.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
              <th style={{ padding: "4px 0" }}>Key</th>
              <th style={{ textAlign: "right" }}>Trades</th>
              <th style={{ textAlign: "right" }}>Win rate</th>
              <th style={{ textAlign: "right" }}>Net P/L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "4px 0" }}>{r.key}</td>
                <td className="numeric" style={{ textAlign: "right" }}>{r.tradesCount}</td>
                <td className="numeric" style={{ textAlign: "right" }}>{pct(r.winRate)}</td>
                <td className="numeric" style={{ textAlign: "right", color: pnlColor(r.netPnl) }}>{signed(r.netPnl, d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CumulativeChart({ data }: { data: PerformanceData }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || data.series.length === 0) return;
    const chart = createChart(el, { ...CHART_BASE, width: el.clientWidth, height: 260 });
    const line = chart.addLineSeries({ color: "#5b8def", lineWidth: 2 });
    // Several trades can settle in the same second; lightweight-charts needs strictly
    // increasing times, so keep the last cumulative value for each timestamp.
    const byTime = new Map<number, number>();
    for (const p of data.series) byTime.set(p.time, p.cumulative);
    line.setData(
      [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value })),
    );
    chart.timeScale().fitContent();
    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [data]);
  if (data.series.length === 0) return null;
  return <div ref={ref} style={{ width: "100%", height: 260 }} />;
}

function PerformanceTab() {
  const [period, setPeriod] = useState<AnalyticsPeriod>("30d");
  const [perf, setPerf] = useState<PerformanceData | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.analyticsSummary(period), api.analyticsPerformance(period)])
      .then(([s, p]) => {
        if (cancelled) return;
        setSummary(s.summary);
        setPerf(p);
      })
      .catch((err) => {
        if (cancelled) return;
        setPerf(null);
        setSummary(null);
        setError(err instanceof ApiError ? err.message : "Could not load analytics");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [period]);

  const meta = perf?.meta;
  const d = meta?.decimals ?? 2;

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <select className="field" value={period} onChange={(e) => setPeriod(e.target.value as AnalyticsPeriod)} aria-label="Period">
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {meta && (
          <>
            <span className={`badge--${meta.accountType === "REAL" ? "real" : "demo"}`}>{meta.accountType === "REAL" ? "REAL account" : "DEMO account"}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {meta.derivAccountId} · {meta.currency} · active account only
            </span>
          </>
        )}
      </div>

      {error && <div className="notice" role="alert">{error}</div>}
      {loading && !perf && !error && <p style={{ color: "var(--text-muted)" }}>Loading…</p>}

      {meta && summary && perf && (
        <>
          {meta.truncated && (
            <div className="notice">
              Only the most recent {meta.tradesAnalyzed} trades were analyzed (the cap is 2000) — figures cover that window, not your full history.
            </div>
          )}
          {meta.excludedRows > 0 && (
            <div className="notice">
              {meta.excludedRows} trade record{meta.excludedRows === 1 ? "" : "s"} from Deriv lacked a usable price or settlement time and {meta.excludedRows === 1 ? "was" : "were"} left out
              rather than guessed.
            </div>
          )}
          {meta.tradesAnalyzed === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No settled trades on this account in the selected period.</p>
          ) : (
            <>
              <SummaryTiles s={summary} d={d} currency={meta.currency} />
              <h3 style={{ fontSize: 13, margin: "18px 0 6px" }}>Cumulative P/L ({meta.currency})</h3>
              <CumulativeChart data={perf} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 24, marginTop: 18 }}>
                <Breakdown title="By source" rows={perf.bySource} d={d} />
                <Breakdown title="By symbol" rows={perf.bySymbol} d={d} />
                <Breakdown title="By contract type" rows={perf.byContractType} d={d} />
                <Breakdown title="By day (UTC)" rows={perf.byDay} d={d} />
              </div>
            </>
          )}
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 16 }}>
            Computed from Deriv's settled-contract records: P/L per trade is sell price − buy price. Days are UTC. Only settled contracts appear. Past results do not predict future results.
          </p>
        </>
      )}
    </div>
  );
}

function TechnicalCharts({ data }: { data: TechnicalData }) {
  const priceRef = useRef<HTMLDivElement>(null);
  const rsiRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const charts: IChartApi[] = [];
    const t = (i: number) => data.candles[i]!.epoch as UTCTimestamp;
    const line = (values: (number | null)[]) =>
      values.flatMap((v, i) => (v === null || !data.candles[i] ? [] : [{ time: t(i), value: v }]));

    if (priceRef.current) {
      const c = createChart(priceRef.current, { ...CHART_BASE, width: priceRef.current.clientWidth, height: 340 });
      const candles = c.addCandlestickSeries({
        upColor: "#3dd68c",
        downColor: "#f2545b",
        borderVisible: false,
        wickUpColor: "#3dd68c",
        wickDownColor: "#f2545b",
      });
      candles.setData(data.candles.map((k) => ({ time: k.epoch as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
      c.addLineSeries({ color: "#e0b341", lineWidth: 1, title: "SMA20" }).setData(line(data.series.sma20));
      c.addLineSeries({ color: "#5b8def", lineWidth: 1, title: "EMA20" }).setData(line(data.series.ema20));
      c.addLineSeries({ color: "#b07cf0", lineWidth: 1, title: "EMA50" }).setData(line(data.series.ema50));
      c.timeScale().fitContent();
      charts.push(c);
    }
    if (rsiRef.current) {
      const c = createChart(rsiRef.current, { ...CHART_BASE, width: rsiRef.current.clientWidth, height: 140 });
      const s = c.addLineSeries({ color: "#5b8def", lineWidth: 1, title: "RSI14" });
      s.setData(line(data.series.rsi14));
      s.createPriceLine({ price: 70, color: "#8b93a3", lineWidth: 1, lineStyle: 2, title: "70" });
      s.createPriceLine({ price: 30, color: "#8b93a3", lineWidth: 1, lineStyle: 2, title: "30" });
      c.timeScale().fitContent();
      charts.push(c);
    }
    if (macdRef.current) {
      const c = createChart(macdRef.current, { ...CHART_BASE, width: macdRef.current.clientWidth, height: 160 });
      const hist = c.addHistogramSeries({ color: "#8b93a3", title: "Hist" });
      hist.setData(
        data.series.macd.histogram.flatMap((v, i) =>
          v === null || !data.candles[i] ? [] : [{ time: t(i), value: v, color: v >= 0 ? "#3dd68c" : "#f2545b" }],
        ),
      );
      c.addLineSeries({ color: "#5b8def", lineWidth: 1, title: "MACD" }).setData(line(data.series.macd.macd));
      c.addLineSeries({ color: "#e0b341", lineWidth: 1, title: "Signal" }).setData(line(data.series.macd.signal));
      c.timeScale().fitContent();
      charts.push(c);
    }

    // Keep the three panes' visible time ranges aligned when the user pans/zooms one of them.
    let syncing = false;
    const unsubs = charts.map((src) => {
      const handler = (range: ReturnType<ReturnType<IChartApi["timeScale"]>["getVisibleLogicalRange"]>) => {
        if (syncing || !range) return;
        syncing = true;
        for (const other of charts) if (other !== src) other.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      };
      src.timeScale().subscribeVisibleLogicalRangeChange(handler);
      return () => src.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    });

    const onResize = () => {
      const els = [priceRef.current, rsiRef.current, macdRef.current];
      charts.forEach((c, i) => {
        const el = els.filter(Boolean)[i];
        if (el) c.applyOptions({ width: el.clientWidth });
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      unsubs.forEach((u) => u());
      charts.forEach((c) => c.remove());
    };
  }, [data]);

  return (
    <div>
      <div ref={priceRef} style={{ width: "100%", height: 340 }} />
      <div ref={rsiRef} style={{ width: "100%", height: 140, marginTop: 6 }} />
      <div ref={macdRef} style={{ width: "100%", height: 160, marginTop: 6 }} />
    </div>
  );
}

const REL: Record<string, string> = { above: "above", below: "below", equal: "equal to" };
const RSI_ZONE: Record<string, string> = {
  above70: "above 70 (conventionally called overbought)",
  below30: "below 30 (conventionally called oversold)",
  between30and70: "between 30 and 70",
};

function Readings({ data }: { data: TechnicalData }) {
  const r = data.readings;
  const rows: Array<[string, string]> = [];
  if (r.lastClose !== null) rows.push(["Last close", String(r.lastClose)]);
  if (r.priceVsEma20) rows.push(["Price vs EMA20", `Close is ${REL[r.priceVsEma20]} EMA20`]);
  if (r.priceVsEma50) rows.push(["Price vs EMA50", `Close is ${REL[r.priceVsEma50]} EMA50`]);
  if (r.ema20VsEma50) rows.push(["EMA20 vs EMA50", `EMA20 is ${REL[r.ema20VsEma50]} EMA50`]);
  if (r.rsi) rows.push(["RSI(14)", `${r.rsi.value.toFixed(1)} — ${RSI_ZONE[r.rsi.zone]}`]);
  if (r.macd)
    rows.push([
      "MACD(12,26,9) histogram",
      `${r.macd.histogram.toFixed(5)} — ${r.macd.sign}${r.macd.changedSignOnLastCandle ? " (sign changed on the last candle)" : ""}`,
    ]);
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ fontSize: 13, margin: "0 0 6px" }}>Current readings</h3>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Not enough candles to compute readings.</p>
      ) : (
        <table style={{ fontSize: 12, borderCollapse: "collapse" }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "4px 16px 4px 0", color: "var(--text-muted)" }}>{k}</td>
                <td className="numeric">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 10 }}>
        These are descriptions of what the indicators currently show, computed with fixed conventional settings (SMA 20, EMA 20/50, RSI 14, MACD 12/26/9). They are not signals,
        advice, or a forecast of where price will go.
      </p>
    </div>
  );
}

function TechnicalTab() {
  const [symbols, setSymbols] = useState<ActiveSymbol[]>([]);
  const [symbol, setSymbol] = useState<string>("");
  const [granularity, setGranularity] = useState(60);
  const [data, setData] = useState<TechnicalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .marketSymbols()
      .then((list) => {
        setSymbols(list);
        if (list[0]) setSymbol((cur) => cur || list[0]!.underlying_symbol);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load symbols"));
    api
      .watchlist()
      .then((w) => w[0] && setSymbol(w[0]))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .analyticsTechnical(symbol, granularity)
      .then((d) => !cancelled && setData(d))
      .catch((err) => {
        if (cancelled) return;
        setData(null);
        setError(err instanceof ApiError ? err.message : "Could not load technical analysis");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [symbol, granularity]);

  const grouped = useMemo(() => [...symbols].sort((a, b) => a.underlying_symbol.localeCompare(b.underlying_symbol)), [symbols]);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <select className="field" value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Symbol">
          {grouped.map((s) => (
            <option key={s.underlying_symbol} value={s.underlying_symbol}>
              {s.underlying_symbol_name ?? s.underlying_symbol} ({s.underlying_symbol})
            </option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 6 }}>
          {GRANULARITIES.map((g) => (
            <button
              key={g.seconds}
              className={`button button--inline${granularity === g.seconds ? "" : " ghost"}`}
              onClick={() => setGranularity(g.seconds)}
            >
              {g.label}
            </button>
          ))}
        </div>
        {loading && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</span>}
      </div>
      {error && <div className="notice" role="alert">{error}</div>}
      {data && (
        <>
          <TechnicalCharts data={data} />
          <Readings data={data} />
        </>
      )}
    </div>
  );
}

export function AnalysisPage() {
  const [tab, setTab] = useState<"performance" | "technical">("performance");
  const status = useDerivStatus();
  const active = status?.accounts.find((a) => a.isActive);

  return (
    <div className="card">
      <h1 style={{ marginTop: 0, fontSize: 18 }}>Analysis</h1>
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <button className={`button button--inline${tab === "performance" ? "" : " ghost"}`} onClick={() => setTab("performance")}>
          Performance
        </button>
        <button className={`button button--inline${tab === "technical" ? "" : " ghost"}`} onClick={() => setTab("technical")}>
          Technical
        </button>
      </div>
      {tab === "performance" && !active ? (
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Connect a Deriv account (Account page) to see your trading performance.</p>
      ) : tab === "performance" ? (
        <PerformanceTab key={active?.derivAccountId} />
      ) : (
        <TechnicalTab />
      )}
    </div>
  );
}
