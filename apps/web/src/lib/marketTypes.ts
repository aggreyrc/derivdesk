export interface ActiveSymbol {
  underlying_symbol: string;
  underlying_symbol_name?: string;
  underlying_symbol_type?: string;
  market: string;
  submarket?: string;
  pip_size?: number;
  exchange_is_open?: 0 | 1;
  is_trading_suspended?: 0 | 1;
}

export interface Candle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
