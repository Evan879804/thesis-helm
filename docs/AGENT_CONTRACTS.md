# Agent 输出契约

## 公司概况分析师

```json
{
  "title": "公司概况报告",
  "summary": "客观摘要",
  "sections": [{ "heading": "主营业务", "bullets": ["资料要点"] }],
  "keyFindings": ["关键发现"],
  "informationGaps": ["未披露或无法确认的信息"],
  "sourceRefs": ["WEB-1", "TUSHARE-daily"]
}
```

## 行业宏观分析师

使用相同结构，内容只覆盖行业生命周期、竞争格局、产业链、政策监管、宏观变量和外部风险，不评价单家公司好坏。

## 综合分析师

使用相同结构，内容覆盖财务指标、盈利能力、估值状态、价格趋势、量能和公司层面风险。Tushare 与代码计算数据优先于网页描述。

## 报告总结师

```json
{
  "title": "研究简报标题",
  "executiveSummary": "综合摘要",
  "keyTakeaways": ["关键研究要点"],
  "companyOverview": ["公司概况"],
  "industryAndMacro": ["行业与宏观"],
  "financialValuationAndMarket": ["财务、估值与市场"],
  "tensionsAndCounterviews": ["分歧与相反观点"],
  "risksAndUncertainties": ["风险与不确定性"],
  "questionsForFurtherResearch": ["下一步研究问题"],
  "sourceRefs": ["来源编号"]
}
```

报告总结师不得调用外部数据源或引入三个子报告之外的新事实。
