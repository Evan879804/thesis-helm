"use client";

import { useEffect, useRef, useState } from "react";

type ProviderSettings = {
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  hasSearchApiKey: boolean;
  updatedAt: string | null;
  tushare: { configured: boolean; points: number };
};

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

type ResearchResult = {
  question: string;
  company: { name: string; industry: string | null };
  tsCode: string;
  asOf: string;
  orchestrator: { workflow: string[]; parallelAgents: number; modelCalls: number; collectionElapsedMs: number; reportElapsedMs: number };
  analystReports: AnalystReport[];
  finalReport: {
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
  sourceIndex: Array<{ ref: string; title: string; url: string | null; kind: string; detail: string }>;
  meta: { model: string; generatedAt: string; dataProviders: string[] };
};

const agentMeta = [
  { id: "orchestrator", index: "00", name: "主协调 Agent", role: "规划任务、调度子 Agent、整合状态" },
  { id: "company-analyst", index: "01", name: "公司概况分析师", role: "主营业务、商业模式、收入结构" },
  { id: "industry-analyst", index: "02", name: "行业宏观分析师", role: "行业周期、竞争、政策与宏观变量" },
  { id: "comprehensive-analyst", index: "03", name: "综合分析师", role: "基本面、估值、行情与技术面" },
  { id: "report-writer", index: "04", name: "报告总结师", role: "整合材料、分歧、风险与研究问题" },
] as const;

const presets = [
  { code: "300750", name: "宁德时代", question: "梳理宁德时代的业务、行业环境、财务与估值，给出值得继续研究的观点和问题。" },
  { code: "600519", name: "贵州茅台", question: "整理贵州茅台的商业模式、增长约束、行业格局和估值讨论线索。" },
  { code: "688981", name: "中芯国际", question: "整理中芯国际的产业位置、政策环境、财务趋势、估值约束和核心争议。" },
];

function toTsCode(code: string): string | null {
  const normalized = code.trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(normalized)) return normalized;
  if (!/^\d{6}$/.test(normalized)) return null;
  if (/^[48]/.test(normalized)) return `${normalized}.BJ`;
  if (/^[569]/.test(normalized)) return `${normalized}.SH`;
  return `${normalized}.SZ`;
}

function reportToMarkdown(result: ResearchResult): string {
  const report = result.finalReport;
  const section = (title: string, items: string[]) => `## ${title}\n\n${items.map((item) => `- ${item}`).join("\n") || "- 暂无"}`;
  const sources = result.sourceIndex.map((source) => `- [${source.ref}] ${source.url ? `[${source.title}](${source.url})` : source.title} — ${source.detail}`).join("\n");
  return `# ${report.title}\n\n> 研究问题：${result.question}\n> 数据截止：${result.asOf}\n> 模型：${result.meta.model}\n\n## 执行摘要\n\n${report.executiveSummary}\n\n${section("关键研究要点", report.keyTakeaways)}\n\n${section("公司概况", report.companyOverview)}\n\n${section("行业与宏观", report.industryAndMacro)}\n\n${section("财务、估值与市场", report.financialValuationAndMarket)}\n\n${section("分歧与相反观点", report.tensionsAndCounterviews)}\n\n${section("风险与不确定性", report.risksAndUncertainties)}\n\n${section("下一步研究问题", report.questionsForFurtherResearch)}\n\n## 信息来源\n\n${sources}\n\n---\n本报告由 AI 基于公开资料整理，仅供研究参考，不构成投资建议。\n`;
}

export default function Home() {
  const [stockCode, setStockCode] = useState("300750");
  const [question, setQuestion] = useState(presets[0].question);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [activeReport, setActiveReport] = useState<AnalystReport["agent"]>("company-analyst");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [providerSettings, setProviderSettings] = useState<ProviderSettings | null>(null);
  const [deepseekKey, setDeepseekKey] = useState("");
  const [tavilyKey, setTavilyKey] = useState("");
  const [deepseekModel, setDeepseekModel] = useState("deepseek-v4-flash");
  const questionRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        questionRef.current?.focus();
      }
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openSettings = async () => {
    setSettingsOpen(true);
    setSettingsLoading(true);
    setSettingsMessage("");
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      const data = await response.json() as ProviderSettings & { error?: string };
      if (!response.ok) throw new Error(data.error || "读取设置失败");
      setProviderSettings(data);
      setDeepseekModel(data.model);
    } catch (settingsError) {
      setSettingsMessage(settingsError instanceof Error ? settingsError.message : "读取设置失败");
    } finally {
      setSettingsLoading(false);
    }
  };

  const saveSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSettingsSaving(true);
    setSettingsMessage("");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: deepseekKey, searchApiKey: tavilyKey, model: deepseekModel }),
      });
      const data = await response.json() as ProviderSettings & { error?: string };
      if (!response.ok) throw new Error(data.error || "保存失败");
      setProviderSettings(data);
      setDeepseekKey("");
      setTavilyKey("");
      setSettingsMessage("连接设置已安全保存");
    } catch (settingsError) {
      setSettingsMessage(settingsError instanceof Error ? settingsError.message : "保存失败");
    } finally {
      setSettingsSaving(false);
    }
  };

  const runResearch = async () => {
    const tsCode = toTsCode(stockCode);
    if (!tsCode) {
      setError("请输入 6 位 A 股代码，例如 300750 或 300750.SZ。");
      return;
    }
    if (question.trim().length < 4) {
      setError("请写下一个具体的研究问题。");
      return;
    }

    setRunning(true);
    setError("");
    setResult(null);
    setPhase(1);
    const timer = window.setInterval(() => setPhase((current) => Math.min(current + 1, 3)), 1800);
    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tsCode, question }),
      });
      const data = await response.json() as ResearchResult & { code?: string; error?: string };
      if (!response.ok) {
        if (data.code === "MODEL_NOT_CONFIGURED" || data.code === "SEARCH_NOT_CONFIGURED") await openSettings();
        throw new Error(data.error || "研究任务失败");
      }
      setResult(data);
      setPhase(4);
      setActiveReport("company-analyst");
      window.setTimeout(() => document.getElementById("report")?.scrollIntoView({ behavior: "smooth" }), 120);
    } catch (researchError) {
      setError(researchError instanceof Error ? researchError.message : "研究任务失败");
      setPhase(0);
    } finally {
      window.clearInterval(timer);
      setRunning(false);
    }
  };

  const applyPreset = (preset: typeof presets[number]) => {
    setStockCode(preset.code);
    setQuestion(preset.question);
    setResult(null);
    setError("");
  };

  const downloadReport = () => {
    if (!result) return;
    const blob = new Blob([reportToMarkdown(result)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${result.tsCode.replace(".", "_")}_research_brief.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const activeAnalystReport = result?.analystReports.find((report) => report.agent === activeReport) ?? null;

  const agentStatus = (agentId: string) => {
    if (phase === 0) return "waiting";
    if (agentId === "orchestrator") return phase === 1 ? "running" : "done";
    if (["company-analyst", "industry-analyst", "comprehensive-analyst"].includes(agentId)) return phase < 2 ? "waiting" : phase === 2 ? "running" : "done";
    return phase < 3 ? "waiting" : phase === 3 ? "running" : "done";
  };

  return (
    <main className="rp-shell">
      <aside className="rp-sidebar">
        <a className="rp-brand" href="#top"><span>RP</span><div><b>ResearchPilot</b><small>Multi-agent research desk</small></div></a>
        <nav aria-label="主导航">
          <a className="active" href="#research">研究任务</a>
          <a href="#workflow">Agent 架构</a>
          <a href="#report">研究报告</a>
          <a href="#sources">资料来源</a>
        </nav>
        <div className="rp-sidebar-note"><span>01</span><p>AI 负责搜集、整理和提出研究视角，最终判断始终属于你。</p></div>
        <button className="rp-settings-button" type="button" onClick={openSettings}>模型与数据设置 <span>→</span></button>
      </aside>

      <section className="rp-main" id="top">
        <header className="rp-topbar">
          <div><span className="rp-live-dot" /> SYSTEM READY</div>
          <div>TUSHARE · TAVILY · DEEPSEEK</div>
        </header>

        <section className="rp-hero" id="research">
          <p className="rp-eyebrow">AUTONOMOUS INVESTMENT RESEARCH</p>
          <h1>把资料搜集交给<br />一支 AI 研究团队。</h1>
          <p className="rp-hero-copy">输入一只 A 股和研究问题，主协调 Agent 将并行调度公司概况、行业宏观和综合分析师，最后生成一份有来源、保留分歧的研究简报。</p>

          <div className="rp-command-card">
            <div className="rp-code-field"><label htmlFor="stock-code">股票代码</label><input id="stock-code" value={stockCode} onChange={(event) => setStockCode(event.target.value)} placeholder="300750" spellCheck={false} /></div>
            <div className="rp-question-field"><label htmlFor="research-question">研究任务</label><textarea ref={questionRef} id="research-question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} /></div>
            <button type="button" onClick={runResearch} disabled={running}>{running ? "研究团队工作中…" : "启动多 Agent 研究"}<span>↗</span></button>
          </div>
          {error && <p className="rp-error" role="alert">{error}</p>}
          <div className="rp-presets"><span>示例任务</span>{presets.map((preset) => <button key={preset.code} type="button" onClick={() => applyPreset(preset)}>{preset.name} · {preset.code}</button>)}</div>
        </section>

        <section className="rp-workflow" id="workflow">
          <div className="rp-section-heading"><div><p className="rp-eyebrow">MULTI-AGENT WORKFLOW</p><h2>一个协调器，四个专业子 Agent。</h2></div><p>前三个分析 Agent 并行工作，报告总结师只整合已有材料，不重新发明事实。</p></div>
          <div className="rp-flow">
            <article className={`rp-agent-card orchestrator ${agentStatus("orchestrator")}`}><span>00</span><div><small>ORCHESTRATOR</small><h3>主协调 Agent</h3><p>解析任务、准备数据、并行调度研究团队。</p></div><i>{agentStatus("orchestrator") === "done" ? "✓" : agentStatus("orchestrator") === "running" ? "•••" : "—"}</i></article>
            <div className="rp-connector"><span>分派任务</span></div>
            <div className="rp-parallel-grid">
              {agentMeta.slice(1, 4).map((agent) => { const status = agentStatus(agent.id); return <article className={`rp-agent-card ${status}`} key={agent.id}><span>{agent.index}</span><div><small>PARALLEL AGENT</small><h3>{agent.name}</h3><p>{agent.role}</p></div><i>{status === "done" ? "✓" : status === "running" ? "•••" : "—"}</i></article>; })}
            </div>
            <div className="rp-connector"><span>汇总材料</span></div>
            <article className={`rp-agent-card writer ${agentStatus("report-writer")}`}><span>04</span><div><small>REPORT AGENT</small><h3>报告总结师</h3><p>整合事实、观点、约束、风险和下一步研究问题。</p></div><i>{agentStatus("report-writer") === "done" ? "✓" : agentStatus("report-writer") === "running" ? "•••" : "—"}</i></article>
          </div>
        </section>

        {result && <section className="rp-report" id="report">
          <div className="rp-report-header"><div><p className="rp-eyebrow">FINAL RESEARCH BRIEF / {result.tsCode}</p><h2>{result.finalReport.title}</h2><p>{result.company.industry ?? "行业未识别"} · 数据截至 {result.asOf} · {result.meta.model}</p></div><button type="button" onClick={downloadReport}>下载 Markdown ↓</button></div>
          <article className="rp-executive"><span>EXECUTIVE SUMMARY</span><p>{result.finalReport.executiveSummary}</p></article>
          <div className="rp-takeaways">{result.finalReport.keyTakeaways.map((item, index) => <article key={item}><span>{String(index + 1).padStart(2, "0")}</span><p>{item}</p></article>)}</div>

          <div className="rp-report-grid">
            <article><span>公司概况</span>{result.finalReport.companyOverview.map((item) => <p key={item}>{item}</p>)}</article>
            <article><span>行业与宏观</span>{result.finalReport.industryAndMacro.map((item) => <p key={item}>{item}</p>)}</article>
            <article><span>财务、估值与市场</span>{result.finalReport.financialValuationAndMarket.map((item) => <p key={item}>{item}</p>)}</article>
            <article><span>分歧与相反观点</span>{result.finalReport.tensionsAndCounterviews.map((item) => <p key={item}>{item}</p>)}</article>
            <article><span>风险与不确定性</span>{result.finalReport.risksAndUncertainties.map((item) => <p key={item}>{item}</p>)}</article>
            <article><span>下一步研究问题</span>{result.finalReport.questionsForFurtherResearch.map((item) => <p key={item}>{item}</p>)}</article>
          </div>

          <div className="rp-agent-output">
            <div className="rp-output-tabs">{result.analystReports.map((report) => <button className={activeReport === report.agent ? "active" : ""} key={report.agent} type="button" onClick={() => setActiveReport(report.agent)}>{agentMeta.find((agent) => agent.id === report.agent)?.name}<small>{(report.elapsedMs / 1000).toFixed(1)}s</small></button>)}</div>
            {activeAnalystReport && <article><div><span>SUB-AGENT OUTPUT</span><h3>{activeAnalystReport.title}</h3><p>{activeAnalystReport.summary}</p></div>{activeAnalystReport.sections.map((section) => <section key={section.heading}><h4>{section.heading}</h4>{section.bullets.map((bullet) => <p key={bullet}>{bullet}</p>)}</section>)}{activeAnalystReport.informationGaps.length > 0 && <section className="rp-gaps"><h4>信息缺口</h4>{activeAnalystReport.informationGaps.map((gap) => <p key={gap}>{gap}</p>)}</section>}</article>}
          </div>

          <section className="rp-sources" id="sources"><div className="rp-section-heading"><div><p className="rp-eyebrow">SOURCE INDEX</p><h2>每条资料都可以回到来源。</h2></div><p>{result.sourceIndex.length} 个来源 · Tushare 结构化数据与 Tavily 公开网页</p></div><div>{result.sourceIndex.map((source) => <article key={source.ref}><span>{source.ref}</span><div>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : <b>{source.title}</b>}<small>{source.detail}</small></div><em>{source.kind === "web" ? "网页" : "数据"}</em></article>)}</div></section>
        </section>}

        <footer className="rp-footer"><b>ResearchPilot</b><p>AI 生成内容仅供研究参考，不构成投资建议。请独立核验重要事实并作出自己的判断。</p></footer>
      </section>

      {settingsOpen && <div className="rp-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="rp-settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><div><p className="rp-eyebrow">CONNECTION SETTINGS</p><h2 id="settings-title">模型与数据连接</h2><p>DeepSeek 与 Tavily Key 加密保存，网页无法回读明文。</p></div><button type="button" onClick={() => setSettingsOpen(false)} aria-label="关闭设置">×</button></header><div className="rp-connection-status"><div className={providerSettings?.tushare.configured ? "connected" : ""}><span /><b>Tushare</b><small>{providerSettings?.tushare.configured ? `${providerSettings.tushare.points} 积分` : "未配置"}</small></div><div className={providerSettings?.hasApiKey ? "connected" : ""}><span /><b>DeepSeek</b><small>{providerSettings?.hasApiKey ? "已配置" : "必填"}</small></div><div className={providerSettings?.hasSearchApiKey ? "connected" : ""}><span /><b>Tavily</b><small>{providerSettings?.hasSearchApiKey ? "已配置" : "必填"}</small></div></div><form onSubmit={saveSettings}><label htmlFor="deepseek-key">DeepSeek API Key</label><input id="deepseek-key" type="password" autoComplete="new-password" value={deepseekKey} onChange={(event) => setDeepseekKey(event.target.value)} placeholder={providerSettings?.hasApiKey ? "已配置；留空保留" : "sk-…"} disabled={settingsLoading || settingsSaving} /><label htmlFor="tavily-key">Tavily API Key</label><input id="tavily-key" type="password" autoComplete="new-password" value={tavilyKey} onChange={(event) => setTavilyKey(event.target.value)} placeholder={providerSettings?.hasSearchApiKey ? "已配置；留空保留" : "tvly-…"} disabled={settingsLoading || settingsSaving} /><label htmlFor="deepseek-model">模型 ID</label><input id="deepseek-model" list="deepseek-models" value={deepseekModel} onChange={(event) => setDeepseekModel(event.target.value)} spellCheck={false} disabled={settingsLoading || settingsSaving} /><datalist id="deepseek-models"><option value="deepseek-v4-flash" /><option value="deepseek-v4-pro" /></datalist>{settingsMessage && <p className={settingsMessage.includes("已安全保存") ? "success" : ""} role="status">{settingsMessage}</p>}<div><button type="button" onClick={() => setSettingsOpen(false)}>取消</button><button type="submit" disabled={settingsLoading || settingsSaving}>{settingsSaving ? "保存中…" : "加密保存"}</button></div></form></section></div>}
    </main>
  );
}
