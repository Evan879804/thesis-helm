import { env } from "cloudflare:workers";
import { callDeepSeekJson } from "../../../lib/deepseek";
import { decryptSecret } from "../../../lib/secret-vault";
import { collectWebResearch, type WebResearchSource } from "../../../lib/tavily";
import { fetchResearchSnapshot } from "../../../lib/tushare";

type RuntimeEnv = { DB: D1Database; SETTINGS_ENCRYPTION_KEY?: string };
type ProviderRow = { base_url: string; model: string; encrypted_api_key: string | null; encrypted_search_api_key: string | null; encrypted_tushare_token: string | null };

type AnalystReport = {
  agent: "company-analyst" | "industry-analyst" | "comprehensive-analyst";
  title: string;
  summary: string;
  sections: Array<{ heading: string; bullets: string[] }>;
  keyFindings: string[];
  informationGaps: string[];
  sourceRefs: string[];
  elapsedMs: number;
};

type FinalReport = {
  title: string;
  executiveSummary: string;
  keyTakeaways: string[];
  companyOverview: string[];
  industryAndMacro: string[];
  financialValuationAndMarket: string[];
  tensionsAndCounterviews: string[];
  risksAndUncertainties: string[];
  questionsForFurtherResearch: string[];
  sourceRefs: string[];
};

type RawAnalystReport = Omit<AnalystReport, "agent" | "elapsedMs">;

function runtimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function userIdFrom(request: Request): string | null {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (userId) return userId;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" ? "local-preview" : null;
}

function strings(value: unknown, max = 12): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, max) : [];
}

function normalizeAnalystReport(agent: AnalystReport["agent"], raw: RawAnalystReport, elapsedMs: number): AnalystReport {
  if (!raw || typeof raw !== "object") throw new Error(`${agent} 没有返回结构化结果`);
  const sections = Array.isArray(raw.sections)
    ? raw.sections.filter((section) => section && typeof section.heading === "string").map((section) => ({ heading: section.heading, bullets: strings(section.bullets, 10) })).slice(0, 8)
    : [];
  return {
    agent,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : agent,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    sections,
    keyFindings: strings(raw.keyFindings, 10),
    informationGaps: strings(raw.informationGaps, 10),
    sourceRefs: strings(raw.sourceRefs, 20),
    elapsedMs,
  };
}

function normalizeFinalReport(raw: Partial<FinalReport>, companyName: string): FinalReport {
  if (!raw || typeof raw !== "object") throw new Error("报告总结 Agent 没有返回结构化结果");
  return {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : `${companyName} 投资研究简报`,
    executiveSummary: typeof raw.executiveSummary === "string" ? raw.executiveSummary : "",
    keyTakeaways: strings(raw.keyTakeaways, 10),
    companyOverview: strings(raw.companyOverview, 12),
    industryAndMacro: strings(raw.industryAndMacro, 12),
    financialValuationAndMarket: strings(raw.financialValuationAndMarket, 12),
    tensionsAndCounterviews: strings(raw.tensionsAndCounterviews, 10),
    risksAndUncertainties: strings(raw.risksAndUncertainties, 12),
    questionsForFurtherResearch: strings(raw.questionsForFurtherResearch, 12),
    sourceRefs: strings(raw.sourceRefs, 30),
  };
}

function sourcePacket(sources: WebResearchSource[]): string {
  return JSON.stringify(sources.map((source, index) => ({
    ref: `WEB-${index + 1}`,
    title: source.title,
    url: source.url,
    excerpt: source.content,
    query: source.query,
  })));
}

async function runAnalyst(args: {
  agent: AnalystReport["agent"];
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}): Promise<AnalystReport> {
  const startedAt = Date.now();
  const raw = await callDeepSeekJson<RawAnalystReport>({
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    model: args.model,
    systemPrompt: `${args.systemPrompt}\n不要给出买卖、仓位、目标价、评级或置信度。不要展示隐藏思维链。所有事实必须引用输入中的 TUSHARE-* 或 WEB-* 编号。返回单一 JSON 对象。`,
    userPrompt: `${args.userPrompt}\n\n返回格式：{"title":"报告标题","summary":"摘要","sections":[{"heading":"小节","bullets":["要点"]}],"keyFindings":["关键发现"],"informationGaps":["资料缺口"],"sourceRefs":["WEB-1","TUSHARE-daily"]}`,
  });
  return normalizeAnalystReport(args.agent, raw, Date.now() - startedAt);
}

export async function POST(request: Request): Promise<Response> {
  const userId = userIdFrom(request);
  if (!userId) return json({ code: "AUTH_REQUIRED", error: "需要登录后才能运行研究" }, 401);

  let body: { question?: unknown; tsCode?: unknown };
  try {
    body = await request.json() as { question?: unknown; tsCode?: unknown };
  } catch {
    return json({ code: "INVALID_REQUEST", error: "请求内容不是有效 JSON" }, 400);
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const tsCode = typeof body.tsCode === "string" ? body.tsCode.trim().toUpperCase() : "";
  if (question.length < 4 || question.length > 500) return json({ code: "INVALID_QUESTION", error: "研究问题长度应为 4–500 个字符" }, 400);
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(tsCode)) return json({ code: "UNSUPPORTED_MARKET", error: "当前版本仅支持 A 股标准代码，如 300750.SZ" }, 400);

  const runtime = runtimeEnv();
  if (!runtime.SETTINGS_ENCRYPTION_KEY) return json({ code: "ENCRYPTION_NOT_CONFIGURED", error: "服务端尚未配置密钥加密功能" }, 503);

  const settings = await runtime.DB.prepare(
    "SELECT base_url, model, encrypted_api_key, encrypted_search_api_key, encrypted_tushare_token FROM provider_settings WHERE user_id = ?",
  ).bind(userId).first<ProviderRow>();
  if (!settings?.encrypted_api_key) return json({ code: "MODEL_NOT_CONFIGURED", error: "请先在“模型与数据”中填写 DeepSeek API Key" }, 409);
  if (!settings.encrypted_search_api_key) return json({ code: "SEARCH_NOT_CONFIGURED", error: "复现 InvestPilot 架构需要联网搜索，请先填写 Tavily API Key" }, 409);
  if (!settings.encrypted_tushare_token) return json({ code: "TUSHARE_NOT_CONFIGURED", error: "请先在“模型与数据”中填写 Tushare Token" }, 409);

  try {
    const [apiKey, searchApiKey, tushareToken] = await Promise.all([
      decryptSecret(settings.encrypted_api_key, runtime.SETTINGS_ENCRYPTION_KEY),
      decryptSecret(settings.encrypted_search_api_key, runtime.SETTINGS_ENCRYPTION_KEY),
      decryptSecret(settings.encrypted_tushare_token, runtime.SETTINGS_ENCRYPTION_KEY),
    ]);

    const collectionStartedAt = Date.now();
    const snapshot = await fetchResearchSnapshot(tushareToken, tsCode);
    const webSources = await collectWebResearch(searchApiKey, snapshot.company.name, tsCode, snapshot.company.industry);
    const collectionElapsedMs = Date.now() - collectionStartedAt;
    const webPacket = sourcePacket(webSources);
    const snapshotPacket = JSON.stringify(snapshot);

    const [companyReport, industryReport, comprehensiveReport] = await Promise.all([
      runAnalyst({
        agent: "company-analyst",
        apiKey,
        baseUrl: settings.base_url,
        model: settings.model,
        systemPrompt: "你是公司概况分析师。只负责整理公司的基本信息、主营业务、商业模式、收入结构、核心产品、客户类型和发展里程碑。以资料搜集和客观整理为主。",
        userPrompt: `股票：${snapshot.company.name}（${tsCode}）\n用户问题：${question}\n结构化快照：${snapshotPacket}\n公开资料：${webPacket}`,
      }),
      runAnalyst({
        agent: "industry-analyst",
        apiKey,
        baseUrl: settings.base_url,
        model: settings.model,
        systemPrompt: "你是行业宏观分析师。只负责行业生命周期、竞争格局、产业链、政策监管、宏观变量、结构性机会与外部约束，不评价单只股票好坏。",
        userPrompt: `公司：${snapshot.company.name}\n行业：${snapshot.company.industry ?? "未识别"}\n用户问题：${question}\n公开资料：${webPacket}`,
      }),
      runAnalyst({
        agent: "comprehensive-analyst",
        apiKey,
        baseUrl: settings.base_url,
        model: settings.model,
        systemPrompt: "你是基本面、估值与市场综合分析师。基于结构化快照描述盈利能力、成长、财务健康、估值状态、价格趋势和量能，并列出数据不足处。代码结果优先于网页描述。",
        userPrompt: `股票：${snapshot.company.name}（${tsCode}）\n用户问题：${question}\nTushare 与代码计算快照：${snapshotPacket}\n公开资料：${webPacket}`,
      }),
    ]);

    const reportStartedAt = Date.now();
    const rawFinalReport = await callDeepSeekJson<Partial<FinalReport>>({
      apiKey,
      baseUrl: settings.base_url,
      model: settings.model,
      systemPrompt: "你是报告总结 Agent。你只能整合三个分析师的输出，不得引入新的事实或数字。明确区分客观资料、分析观点、相反解释和信息缺口。输出用于辅助用户研究，不替用户作投资决定，不给出评级、置信度、买卖、仓位、目标价或收益承诺。不要展示隐藏思维链。返回单一 JSON 对象。",
      userPrompt: `用户问题：${question}\n\n公司概况分析：${JSON.stringify(companyReport)}\n\n行业宏观分析：${JSON.stringify(industryReport)}\n\n综合分析：${JSON.stringify(comprehensiveReport)}\n\n返回格式：{"title":"研究简报标题","executiveSummary":"综合摘要","keyTakeaways":["关键研究要点"],"companyOverview":["公司概况"],"industryAndMacro":["行业与宏观"],"financialValuationAndMarket":["财务估值与市场"],"tensionsAndCounterviews":["分歧与相反观点"],"risksAndUncertainties":["风险与不确定性"],"questionsForFurtherResearch":["下一步研究问题"],"sourceRefs":["引用编号"]}`,
      maxTokens: 5000,
    });
    const finalReport = normalizeFinalReport(rawFinalReport, snapshot.company.name);

    const sourceIndex = [
      ...snapshot.sources.map((source) => ({ ref: `TUSHARE-${source.api}`, title: `Tushare ${source.api}`, url: null, kind: "structured", detail: `${source.rows} 行` })),
      ...webSources.map((source, index) => ({ ref: `WEB-${index + 1}`, title: source.title, url: source.url, kind: "web", detail: new URL(source.url).hostname })),
    ];

    return json({
      question,
      company: snapshot.company,
      tsCode,
      asOf: snapshot.asOf,
      orchestrator: {
        workflow: ["company-analyst", "industry-analyst", "comprehensive-analyst", "report-writer"],
        parallelAgents: 3,
        modelCalls: 4,
        collectionElapsedMs,
        reportElapsedMs: Date.now() - reportStartedAt,
      },
      snapshot,
      analystReports: [companyReport, industryReport, comprehensiveReport],
      finalReport,
      sourceIndex,
      meta: { model: settings.model, generatedAt: new Date().toISOString(), dataProviders: ["Tushare Pro", "Tavily"] },
    });
  } catch (error) {
    return json({ code: "RESEARCH_FAILED", error: error instanceof Error ? error.message : "研究执行失败" }, 502);
  }
}
