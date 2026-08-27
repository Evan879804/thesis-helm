const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export type WebResearchSource = {
  title: string;
  url: string;
  content: string;
  score: number | null;
  query: string;
};

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
};

type TavilyResponse = { results?: TavilyResult[] };

async function search(apiKey: string, query: string): Promise<WebResearchSource[]> {
  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      max_results: 4,
      country: "china",
    }),
  });
  if (!response.ok) throw new Error(`Tavily 搜索失败（HTTP ${response.status}）`);
  const result = await response.json() as TavilyResponse;
  return (result.results ?? [])
    .filter((item): item is Required<Pick<TavilyResult, "title" | "url" | "content">> & TavilyResult => Boolean(item.title && item.url && item.content))
    .map((item) => ({
      title: item.title,
      url: item.url,
      content: item.content.slice(0, 900),
      score: typeof item.score === "number" ? item.score : null,
      query,
    }));
}

export async function collectWebResearch(
  apiKey: string,
  companyName: string,
  tsCode: string,
  industry: string | null,
): Promise<WebResearchSource[]> {
  const queries = [
    `${companyName} ${tsCode} 公司官网 主营业务 收入结构 最新年报`,
    `${companyName} ${tsCode} 最新公告 重大事项 新闻`,
    `${industry ?? companyName} 行业 竞争格局 政策 趋势`,
  ];
  const results = await Promise.allSettled(queries.map((query) => search(apiKey, query)));
  const sources = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  }).slice(0, 10);
}
