const TUSHARE_API_URL = "https://api.tushare.pro";

type TushareResponse = {
  code: number;
  msg?: string;
  data?: { fields?: string[]; items?: unknown[][] };
};

type DataRow = Record<string, unknown>;

export type ResearchSnapshot = {
  tsCode: string;
  company: { name: string; industry: string | null; market: string | null; listDate: string | null };
  asOf: string;
  price: {
    close: number;
    rangeStart: string;
    rangeEnd: string;
    periodReturnPct: number;
    maxDrawdownPct: number;
    annualizedVolatilityPct: number;
    volumeTrend: number | null;
  };
  valuation: {
    peTtm: number | null;
    pb: number | null;
    psTtm: number | null;
    dividendYieldTtm: number | null;
    totalMarketValueCny100m: number | null;
  };
  financial: {
    period: string | null;
    roe: number | null;
    grossMargin: number | null;
    netMargin: number | null;
    debtToAssets: number | null;
    operatingCashFlowPerShare: number | null;
    quarterlySalesYoy: number | null;
    quarterlyNetProfitYoy: number | null;
  };
  sources: Array<{ api: string; parameters: Record<string, string>; rows: number }>;
  limitations: string[];
};

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function rowsFrom(response: TushareResponse): DataRow[] {
  const fields = response.data?.fields ?? [];
  const items = response.data?.items ?? [];
  return items.map((item) => Object.fromEntries(fields.map((field, index) => [field, item[index]])));
}

async function callTushare(
  token: string,
  apiName: string,
  params: Record<string, string>,
  fields: string,
): Promise<DataRow[]> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(TUSHARE_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_name: apiName, token, params, fields }),
      });
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) throw new Error(`Tushare HTTP ${response.status}`);
        throw new Error(`Tushare request rejected with HTTP ${response.status}`);
      }
      const result = await response.json() as TushareResponse;
      if (result.code !== 0) throw new Error(result.msg || `Tushare ${apiName} returned code ${result.code}`);
      return rowsFrom(result);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 0 && /HTTP (429|5\d\d)/.test(lastError.message)) continue;
      break;
    }
  }
  throw lastError ?? new Error(`Tushare ${apiName} request failed`);
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdown(closes: number[]): number {
  let peak = closes[0] ?? 0;
  let worst = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    if (peak > 0) worst = Math.min(worst, (close / peak) - 1);
  }
  return worst * 100;
}

export async function fetchResearchSnapshot(token: string, tsCode: string): Promise<ResearchSnapshot> {
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 120);
  const dateParams = { ts_code: tsCode, start_date: formatDate(startDate), end_date: formatDate(endDate) };

  const [basicResult, dailyResult, valuationResult, financialResult] = await Promise.allSettled([
    callTushare(token, "stock_basic", { ts_code: tsCode }, "ts_code,name,industry,market,list_date"),
    callTushare(token, "daily", dateParams, "ts_code,trade_date,close,pct_chg,vol,amount"),
    callTushare(token, "daily_basic", dateParams, "ts_code,trade_date,close,pe_ttm,pb,ps_ttm,dv_ttm,total_mv,turnover_rate,volume_ratio"),
    callTushare(token, "fina_indicator", { ts_code: tsCode }, "ts_code,ann_date,end_date,roe,grossprofit_margin,netprofit_margin,debt_to_assets,ocfps,q_sales_yoy,q_netprofit_yoy"),
  ]);

  if (dailyResult.status === "rejected") throw new Error(`无法获取日线行情：${dailyResult.reason instanceof Error ? dailyResult.reason.message : "未知错误"}`);
  const dailyRows = dailyResult.value.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
  if (dailyRows.length < 2) throw new Error("日线数据不足，无法完成区间分析");

  const limitations: string[] = [];
  if (basicResult.status === "rejected") limitations.push(`公司基本信息不可用：${basicResult.reason instanceof Error ? basicResult.reason.message : "未知错误"}`);
  if (valuationResult.status === "rejected") limitations.push(`估值数据不可用：${valuationResult.reason instanceof Error ? valuationResult.reason.message : "可能缺少 daily_basic 权限"}`);
  if (financialResult.status === "rejected") limitations.push(`财务指标不可用：${financialResult.reason instanceof Error ? financialResult.reason.message : "可能缺少 fina_indicator 权限"}`);

  const companyRow = basicResult.status === "fulfilled" ? basicResult.value[0] : undefined;
  const valuationRows = valuationResult.status === "fulfilled"
    ? valuationResult.value.sort((a, b) => String(b.trade_date).localeCompare(String(a.trade_date)))
    : [];
  const financialRows = financialResult.status === "fulfilled"
    ? financialResult.value.sort((a, b) => String(b.end_date).localeCompare(String(a.end_date)))
    : [];
  const latestValuation = valuationRows[0];
  const latestFinancial = financialRows[0];

  const closes = dailyRows.map((row) => asNumber(row.close)).filter((value): value is number => value !== null);
  const returns = dailyRows.map((row) => asNumber(row.pct_chg)).filter((value): value is number => value !== null).map((value) => value / 100);
  const volumes = dailyRows.map((row) => asNumber(row.vol)).filter((value): value is number => value !== null);
  if (closes.length < 2) throw new Error("日线收盘价存在缺失，无法完成区间分析");
  const recentVolume = volumes.slice(-5);
  const priorVolume = volumes.slice(-25, -5);
  const recentAverage = recentVolume.length ? recentVolume.reduce((sum, value) => sum + value, 0) / recentVolume.length : null;
  const priorAverage = priorVolume.length ? priorVolume.reduce((sum, value) => sum + value, 0) / priorVolume.length : null;

  return {
    tsCode,
    company: {
      name: String(companyRow?.name ?? tsCode),
      industry: companyRow?.industry ? String(companyRow.industry) : null,
      market: companyRow?.market ? String(companyRow.market) : null,
      listDate: companyRow?.list_date ? String(companyRow.list_date) : null,
    },
    asOf: String(dailyRows.at(-1)?.trade_date ?? formatDate(endDate)),
    price: {
      close: round(closes.at(-1) ?? 0),
      rangeStart: String(dailyRows[0].trade_date),
      rangeEnd: String(dailyRows.at(-1)?.trade_date),
      periodReturnPct: round(((closes.at(-1) ?? 0) / closes[0] - 1) * 100),
      maxDrawdownPct: round(maxDrawdown(closes)),
      annualizedVolatilityPct: round(standardDeviation(returns) * Math.sqrt(244) * 100),
      volumeTrend: recentAverage !== null && priorAverage ? round(recentAverage / priorAverage, 2) : null,
    },
    valuation: {
      peTtm: asNumber(latestValuation?.pe_ttm),
      pb: asNumber(latestValuation?.pb),
      psTtm: asNumber(latestValuation?.ps_ttm),
      dividendYieldTtm: asNumber(latestValuation?.dv_ttm),
      totalMarketValueCny100m: latestValuation?.total_mv === undefined ? null : round((asNumber(latestValuation.total_mv) ?? 0) / 10000),
    },
    financial: {
      period: latestFinancial?.end_date ? String(latestFinancial.end_date) : null,
      roe: asNumber(latestFinancial?.roe),
      grossMargin: asNumber(latestFinancial?.grossprofit_margin),
      netMargin: asNumber(latestFinancial?.netprofit_margin),
      debtToAssets: asNumber(latestFinancial?.debt_to_assets),
      operatingCashFlowPerShare: asNumber(latestFinancial?.ocfps),
      quarterlySalesYoy: asNumber(latestFinancial?.q_sales_yoy),
      quarterlyNetProfitYoy: asNumber(latestFinancial?.q_netprofit_yoy),
    },
    sources: [
      { api: "daily", parameters: dateParams, rows: dailyRows.length },
      { api: "daily_basic", parameters: dateParams, rows: valuationRows.length },
      { api: "fina_indicator", parameters: { ts_code: tsCode }, rows: financialRows.length },
    ],
    limitations,
  };
}
