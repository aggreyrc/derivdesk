import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { ContractFor, ContractType, Proposal } from "@derivdesk/shared-types";
import { api, ApiError } from "../lib/api";
import { useMarketTick } from "../lib/useMarketTick";
import { useDerivStatus } from "../lib/derivStatus";
import type { ActiveSymbol } from "../lib/marketTypes";

const GRANULARITIES = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "1h", seconds: 3600 },
  { label: "1d", seconds: 86400 },
];

function SymbolRow({ symbol, starred, onToggleStar, onSelect, selected }: { symbol: ActiveSymbol; starred: boolean; onToggleStar: () => void; onSelect: () => void; selected: boolean }) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 6px",
        borderRadius: 4,
        cursor: "pointer",
        background: selected ? "rgba(91,141,239,0.12)" : "transparent",
      }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar();
        }}
        style={{ background: "none", border: "none", color: starred ? "var(--accent)" : "var(--text-muted)", cursor: "pointer", fontSize: 15, padding: 0, width: 18 }}
        title={starred ? "Remove from watchlist" : "Add to watchlist"}
      >
        {starred ? "★" : "☆"}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {symbol.underlying_symbol_name ?? symbol.underlying_symbol}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{symbol.market}</div>
      </div>
    </div>
  );
}

function LivePrice({ symbol, pipSize }: { symbol: string; pipSize: number | null }) {
  const tick = useMarketTick(symbol);
  const decimals = pipSize ? Math.max(0, Math.round(-Math.log10(pipSize))) : 4;
  return (
    <span className="numeric" style={{ fontSize: 13 }}>
      {tick ? tick.quote.toFixed(decimals) : "—"}
    </span>
  );
}

// Only used to make the selector readable — Deriv's own capability list (contracts-for)
// is still what decides which of these actually show up for a given symbol. An unmapped
// contract_type still renders fine, just as its raw Deriv code.
const CONTRACT_TYPE_LABELS: Partial<Record<ContractType, string>> = {
  CALL: "Rise",
  PUT: "Fall",
  HIGHER: "Higher",
  LOWER: "Lower",
  ONETOUCH: "Touches",
  NOTOUCH: "Does Not Touch",
  DIGITMATCH: "Digit Matches",
  DIGITDIFF: "Digit Differs",
  DIGITOVER: "Digit Over",
  DIGITUNDER: "Digit Under",
  DIGITODD: "Digit Odd",
  DIGITEVEN: "Digit Even",
  MULTUP: "Multiplier Up",
  MULTDOWN: "Multiplier Down",
  RUNHIGH: "Only Ups",
  RUNLOW: "Only Downs",
  ACCU: "Accumulator",
};

const BARRIER_CONTRACT_TYPES = new Set<ContractType>([
  "HIGHER", "LOWER", "ONETOUCH", "NOTOUCH", "DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER",
]);

const DURATION_UNITS: Array<{ value: "t" | "s" | "m" | "h" | "d"; label: string }> = [
  { value: "t", label: "Ticks" },
  { value: "s", label: "Seconds" },
  { value: "m", label: "Minutes" },
  { value: "h", label: "Hours" },
  { value: "d", label: "Days" },
];

function TradeTicket({ symbol }: { symbol: string }) {
  const derivStatus = useDerivStatus();
  const activeAccount = derivStatus?.accounts.find((a) => a.isActive);

  const [contracts, setContracts] = useState<ContractFor[]>([]);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [contractType, setContractType] = useState<ContractType | null>(null);
  const [amount, setAmount] = useState(10);
  const [basis, setBasis] = useState<"stake" | "payout">("stake");
  const [duration, setDuration] = useState(5);
  const [durationUnit, setDurationUnit] = useState<"t" | "s" | "m" | "h" | "d">("t");
  const [barrier, setBarrier] = useState("");

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    setContracts([]);
    setContractType(null);
    setProposal(null);
    setError(null);
    setSuccess(null);
    setLoadingContracts(true);
    api
      .contractsFor(symbol)
      .then((available) => {
        setContracts(available);
        // De-duplicate contract_type while preferring the first (most common) entry Deriv lists.
        const first = available[0]?.contract_type ?? null;
        setContractType(first);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load what this market supports"))
      .finally(() => setLoadingContracts(false));
  }, [symbol]);

  const contractTypeOptions = useMemo(() => {
    const seen = new Set<ContractType>();
    const ordered: ContractType[] = [];
    for (const c of contracts) {
      if (!seen.has(c.contract_type)) {
        seen.add(c.contract_type);
        ordered.push(c.contract_type);
      }
    }
    return ordered;
  }, [contracts]);

  async function handleGetPrice() {
    if (!contractType) return;
    setQuoting(true);
    setError(null);
    setSuccess(null);
    setProposal(null);
    try {
      const result = await api.proposal({
        contractType,
        symbol,
        amount,
        basis,
        duration,
        durationUnit,
        barrier: barrier.trim() || undefined,
      });
      setProposal(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not get a price for this contract");
    } finally {
      setQuoting(false);
    }
  }

  async function handleBuy() {
    if (!proposal || !contractType) return;
    const askPrice = proposal.ask_price !== undefined ? Number(proposal.ask_price) : amount;
    const isReal = activeAccount?.accountType === "REAL";
    if (isReal && !window.confirm(`Buy this contract for ${askPrice.toFixed(2)} ${activeAccount?.currency}? This uses real money.`)) {
      return;
    }
    setBuying(true);
    setError(null);
    try {
      const result = await api.buy({
        proposalId: proposal.id,
        priceAgreed: askPrice,
        contractType,
        underlyingSymbol: symbol,
        confirmReal: isReal,
      });
      setSuccess(`Bought — contract #${result.contract_id}. See it on the Portfolio page.`);
      setProposal(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not place this trade");
    } finally {
      setBuying(false);
    }
  }

  if (!activeAccount) {
    return (
      <div className="card">
        <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
          Connect and activate a Deriv account on the Account page to trade this market.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Trade ticket</h2>
        <span className={`badge badge--${activeAccount.accountType.toLowerCase()}`}>
          {activeAccount.accountType} · {activeAccount.currency}
        </span>
      </div>

      {error && <div className="error-text">{error}</div>}
      {success && <div style={{ color: "var(--positive)", fontSize: 13, marginBottom: 12 }}>{success}</div>}

      {loadingContracts ? (
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Checking what this market supports…</p>
      ) : contractTypeOptions.length === 0 ? (
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Deriv doesn't currently offer any contracts on this market.</p>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <label className="field" style={{ margin: 0 }}>
              <span>Contract type</span>
              <select
                value={contractType ?? ""}
                onChange={(e) => {
                  setContractType(e.target.value as ContractType);
                  setProposal(null);
                }}
                style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 9px", color: "var(--text)" }}
              >
                {contractTypeOptions.map((t) => (
                  <option key={t} value={t}>
                    {CONTRACT_TYPE_LABELS[t] ?? t}
                  </option>
                ))}
              </select>
            </label>

            <label className="field" style={{ margin: 0 }}>
              <span>{basis === "stake" ? "Stake" : "Payout"}</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => {
                  setAmount(Number(e.target.value));
                  setProposal(null);
                }}
              />
            </label>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <label className="field" style={{ margin: 0 }}>
              <span>Basis</span>
              <select
                value={basis}
                onChange={(e) => {
                  setBasis(e.target.value as "stake" | "payout");
                  setProposal(null);
                }}
                style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 9px", color: "var(--text)" }}
              >
                <option value="stake">Stake</option>
                <option value="payout">Payout</option>
              </select>
            </label>

            <label className="field" style={{ margin: 0 }}>
              <span>Duration</span>
              <input
                type="number"
                min={1}
                value={duration}
                onChange={(e) => {
                  setDuration(Number(e.target.value));
                  setProposal(null);
                }}
              />
            </label>

            <label className="field" style={{ margin: 0 }}>
              <span>Unit</span>
              <select
                value={durationUnit}
                onChange={(e) => {
                  setDurationUnit(e.target.value as typeof durationUnit);
                  setProposal(null);
                }}
                style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 9px", color: "var(--text)" }}
              >
                {DURATION_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {contractType && BARRIER_CONTRACT_TYPES.has(contractType) && (
            <label className="field">
              <span>Barrier</span>
              <input
                placeholder={contractType.startsWith("DIGIT") ? "Digit, e.g. 5" : "e.g. +0.5 or an absolute price"}
                value={barrier}
                onChange={(e) => {
                  setBarrier(e.target.value);
                  setProposal(null);
                }}
              />
            </label>
          )}

          {proposal ? (
            <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                <span style={{ color: "var(--text-muted)" }}>Price</span>
                <span className="numeric">
                  {proposal.ask_price !== undefined ? `${Number(proposal.ask_price).toFixed(2)} ${activeAccount.currency}` : "—"}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span style={{ color: "var(--text-muted)" }}>Payout</span>
                <span className="numeric">
                  {proposal.payout !== undefined ? `${Number(proposal.payout).toFixed(2)} ${activeAccount.currency}` : "—"}
                </span>
              </div>
              {proposal.longcode && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>{proposal.longcode}</div>}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 10 }}>
            <button className="button" style={{ width: "auto", padding: "9px 16px", background: "transparent", border: "1px solid var(--border)", color: "var(--text)" }} onClick={handleGetPrice} disabled={quoting || !contractType}>
              {quoting ? "Pricing…" : "Get price"}
            </button>
            <button className="button" style={{ width: "auto", padding: "9px 20px" }} onClick={handleBuy} disabled={!proposal || buying}>
              {buying ? "Buying…" : "Buy"}
            </button>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 10, marginBottom: 0 }}>
            This is not trading advice — nothing here predicts or guarantees an outcome. Prices and payouts come straight from Deriv and
            can move before you confirm; buying re-sends this exact price, and Deriv rejects the trade if it's no longer available.
          </p>
        </>
      )}
    </div>
  );
}

export function MarketsPage() {
  const [symbols, setSymbols] = useState<ActiveSymbol[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [granularity, setGranularity] = useState(60);
  const [pipSize, setPipSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingChart, setLoadingChart] = useState(false);

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    api.marketSymbols().then(setSymbols).catch((err) => setError(err instanceof ApiError ? err.message : "Could not load symbols"));
    api.watchlist().then((list) => {
      setWatchlist(list);
      if (list[0]) setSelected(list[0]);
    });
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return symbols;
    return symbols.filter((s) => s.underlying_symbol.toLowerCase().includes(q) || (s.underlying_symbol_name ?? "").toLowerCase().includes(q));
  }, [symbols, search]);

  async function toggleStar(symbol: string) {
    const next = watchlist.includes(symbol) ? await api.watchlistRemove(symbol) : await api.watchlistAdd(symbol);
    setWatchlist(next);
  }

  // Mount the chart once.
  useEffect(() => {
    if (!chartContainerRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      layout: { background: { color: "transparent" }, textColor: "#8b93a3" },
      grid: { vertLines: { color: "#232a36" }, horzLines: { color: "#232a36" } },
      rightPriceScale: { borderColor: "#232a36" },
      timeScale: { borderColor: "#232a36", timeVisible: true },
      height: 360,
    });
    const series = chart.addCandlestickSeries({ upColor: "#3dd68c", downColor: "#f2545b", borderVisible: false, wickUpColor: "#3dd68c", wickDownColor: "#f2545b" });
    chartRef.current = chart;
    seriesRef.current = series;

    const resize = () => chart.applyOptions({ width: chartContainerRef.current!.clientWidth });
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.remove();
    };
  }, []);

  // Load candles whenever the selected symbol or granularity changes.
  useEffect(() => {
    if (!selected || !seriesRef.current) return;
    setLoadingChart(true);
    setError(null);
    api
      .marketCandles(selected, granularity, 200)
      .then(({ candles, pipSize: p }) => {
        setPipSize(p);
        seriesRef.current!.setData(candles.map((c) => ({ time: c.epoch as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
        chartRef.current?.timeScale().fitContent();
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load candles"))
      .finally(() => setLoadingChart(false));
  }, [selected, granularity]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16, alignItems: "start" }}>
      <div className="card" style={{ maxHeight: 620, overflowY: "auto" }}>
        <div style={{ marginBottom: 10 }}>
          <input
            placeholder="Search markets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 9px", color: "var(--text)" }}
          />
        </div>
        {watchlist.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "4px 0" }}>Watchlist</div>
            {watchlist.map((symbol) => {
              const s = symbols.find((x) => x.underlying_symbol === symbol);
              return (
                <div key={symbol} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 6px" }}>
                  <span style={{ fontSize: 13, cursor: "pointer" }} onClick={() => setSelected(symbol)}>
                    {s?.underlying_symbol_name ?? symbol}
                  </span>
                  <LivePrice symbol={symbol} pipSize={s?.pip_size ?? null} />
                </div>
              );
            })}
            <div style={{ borderTop: "1px solid var(--border)", margin: "8px 0" }} />
          </>
        )}
        <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "4px 0" }}>All markets</div>
        {filtered.slice(0, 100).map((s) => (
          <SymbolRow
            key={s.underlying_symbol}
            symbol={s}
            starred={watchlist.includes(s.underlying_symbol)}
            onToggleStar={() => toggleStar(s.underlying_symbol)}
            onSelect={() => setSelected(s.underlying_symbol)}
            selected={selected === s.underlying_symbol}
          />
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div className="card">
        {error && <div className="error-text">{error}</div>}
        {!selected ? (
          <p style={{ color: "var(--text-muted)" }}>Pick a market on the left to see its chart.</p>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{symbols.find((s) => s.underlying_symbol === selected)?.underlying_symbol_name ?? selected}</div>
                <LivePrice symbol={selected} pipSize={pipSize} />
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {GRANULARITIES.map((g) => (
                  <button
                    key={g.label}
                    onClick={() => setGranularity(g.seconds)}
                    style={{
                      background: granularity === g.seconds ? "var(--accent)" : "transparent",
                      color: granularity === g.seconds ? "#0a0d12" : "var(--text-muted)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      padding: "3px 9px",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
            <div ref={chartContainerRef} style={{ width: "100%", opacity: loadingChart ? 0.5 : 1 }} />
            <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 8 }}>
              Chart shows candles as of the last load — it doesn't yet redraw the forming candle from live ticks (the price above does update live).
              Switch timeframes or reselect the market to refresh.
            </p>
          </>
        )}
      </div>

      {selected && <TradeTicket symbol={selected} />}
      </div>
    </div>
  );
}
