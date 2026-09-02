export async function callDeepSeekJson<T>(args: {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
}): Promise<T> {
  const endpoint = `${args.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let lastError: Error | null = null;

  // DeepSeek 的 JSON Output 偶尔会返回空 content。第一次使用原生 JSON
  // 模式；如正文为空或 JSON 被截断，第二次改用普通文本并继续要求 JSON。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: "system", content: args.systemPrompt },
          {
            role: "user",
            content: attempt === 0
              ? args.userPrompt
              : `${args.userPrompt}\n\n上一次没有得到可解析的正文。请直接输出完整 JSON 对象，不要使用 Markdown 代码块，不要输出解释。`,
          },
        ],
        // V4 默认开启思考模式。结构化研究步骤不需要隐藏推理；关闭后可把
        // 输出预算留给最终正文，并显著减少空 content 和超时。
        thinking: { type: "disabled" },
        ...(attempt === 0 ? { response_format: { type: "json_object" } } : {}),
        max_tokens: args.maxTokens ?? 4000,
        stream: false,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      const requestError = new Error(`DeepSeek 请求失败（HTTP ${response.status}）：${detail.slice(0, 180)}`);
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        lastError = requestError;
        continue;
      }
      throw requestError;
    }

    const result = await response.json() as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string | null; reasoning_content?: string | null };
      }>;
    };
    const choice = result.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (!content) {
      const reason = choice?.finish_reason ? `，结束原因：${choice.finish_reason}` : "";
      lastError = new Error(`DeepSeek 未返回正文${reason}`);
      continue;
    }

    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(cleaned.slice(start, end + 1)) as T;
        } catch {
          // Fall through to the retry/error below.
        }
      }
      lastError = new Error(`DeepSeek 返回的正文不是有效 JSON（结束原因：${choice?.finish_reason ?? "未知"}）`);
    }
  }

  throw new Error(`${lastError?.message ?? "DeepSeek 未返回可解析内容"}，系统已自动重试`);
}
