import { env } from "cloudflare:workers";
import { encryptSecret } from "../../../lib/secret-vault";

const DEFAULT_PROVIDER = "deepseek";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

type RuntimeEnv = {
  DB: D1Database;
  SETTINGS_ENCRYPTION_KEY?: string;
};

type SettingsRow = {
  provider: string;
  base_url: string;
  model: string;
  encrypted_api_key: string | null;
  encrypted_search_api_key: string | null;
  encrypted_tushare_token: string | null;
  updated_at: string;
};

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

async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS provider_settings (
      user_id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL DEFAULT 'deepseek',
      base_url TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
      model TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
      encrypted_api_key TEXT,
      encrypted_search_api_key TEXT,
      encrypted_tushare_token TEXT,
      updated_at TEXT NOT NULL
    )
  `).run();
  const columns = await db.prepare("PRAGMA table_info(provider_settings)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "encrypted_search_api_key")) {
    await db.prepare("ALTER TABLE provider_settings ADD COLUMN encrypted_search_api_key TEXT").run();
  }
  if (!columns.results.some((column) => column.name === "encrypted_tushare_token")) {
    await db.prepare("ALTER TABLE provider_settings ADD COLUMN encrypted_tushare_token TEXT").run();
  }
}

export async function GET(request: Request): Promise<Response> {
  const userId = userIdFrom(request);
  if (!userId) return json({ error: "需要登录后才能读取模型设置" }, 401);

  const runtime = runtimeEnv();
  await ensureTable(runtime.DB);
  const row = await runtime.DB.prepare(
    "SELECT provider, base_url, model, encrypted_api_key, encrypted_search_api_key, encrypted_tushare_token, updated_at FROM provider_settings WHERE user_id = ?",
  ).bind(userId).first<SettingsRow>();

  return json({
    provider: row?.provider ?? DEFAULT_PROVIDER,
    baseUrl: row?.base_url ?? DEFAULT_BASE_URL,
    model: row?.model ?? DEFAULT_MODEL,
    hasApiKey: Boolean(row?.encrypted_api_key),
    hasSearchApiKey: Boolean(row?.encrypted_search_api_key),
    hasTushareToken: Boolean(row?.encrypted_tushare_token),
    updatedAt: row?.updated_at ?? null,
  });
}

export async function PUT(request: Request): Promise<Response> {
  const userId = userIdFrom(request);
  if (!userId) return json({ error: "需要登录后才能保存模型设置" }, 401);

  let body: { apiKey?: unknown; searchApiKey?: unknown; tushareToken?: unknown; model?: unknown };
  try {
    body = await request.json() as { apiKey?: unknown; searchApiKey?: unknown; tushareToken?: unknown; model?: unknown };
  } catch {
    return json({ error: "设置内容不是有效 JSON" }, 400);
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const searchApiKey = typeof body.searchApiKey === "string" ? body.searchApiKey.trim() : "";
  const tushareToken = typeof body.tushareToken === "string" ? body.tushareToken.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!MODEL_PATTERN.test(model)) return json({ error: "请输入有效的 DeepSeek 模型 ID" }, 400);
  if (apiKey && (apiKey.length < 16 || apiKey.length > 512)) return json({ error: "API Key 格式不正确" }, 400);
  if (searchApiKey && (searchApiKey.length < 16 || searchApiKey.length > 512)) return json({ error: "Tavily API Key 格式不正确" }, 400);
  if (tushareToken && (tushareToken.length < 16 || tushareToken.length > 512)) return json({ error: "Tushare Token 格式不正确" }, 400);

  const runtime = runtimeEnv();
  if (!runtime.SETTINGS_ENCRYPTION_KEY) return json({ error: "服务端尚未配置密钥加密功能" }, 503);
  await ensureTable(runtime.DB);

  const existing = await runtime.DB.prepare(
    "SELECT encrypted_api_key, encrypted_search_api_key, encrypted_tushare_token FROM provider_settings WHERE user_id = ?",
  ).bind(userId).first<{ encrypted_api_key: string | null; encrypted_search_api_key: string | null; encrypted_tushare_token: string | null }>();

  const encryptedApiKey = apiKey
    ? await encryptSecret(apiKey, runtime.SETTINGS_ENCRYPTION_KEY)
    : existing?.encrypted_api_key ?? null;
  const encryptedSearchApiKey = searchApiKey
    ? await encryptSecret(searchApiKey, runtime.SETTINGS_ENCRYPTION_KEY)
    : existing?.encrypted_search_api_key ?? null;
  const encryptedTushareToken = tushareToken
    ? await encryptSecret(tushareToken, runtime.SETTINGS_ENCRYPTION_KEY)
    : existing?.encrypted_tushare_token ?? null;
  const updatedAt = new Date().toISOString();

  await runtime.DB.prepare(`
    INSERT INTO provider_settings (user_id, provider, base_url, model, encrypted_api_key, encrypted_search_api_key, encrypted_tushare_token, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      provider = excluded.provider,
      base_url = excluded.base_url,
      model = excluded.model,
      encrypted_api_key = excluded.encrypted_api_key,
      encrypted_search_api_key = excluded.encrypted_search_api_key,
      encrypted_tushare_token = excluded.encrypted_tushare_token,
      updated_at = excluded.updated_at
  `).bind(userId, DEFAULT_PROVIDER, DEFAULT_BASE_URL, model, encryptedApiKey, encryptedSearchApiKey, encryptedTushareToken, updatedAt).run();

  return json({
    provider: DEFAULT_PROVIDER,
    baseUrl: DEFAULT_BASE_URL,
    model,
    hasApiKey: Boolean(encryptedApiKey),
    hasSearchApiKey: Boolean(encryptedSearchApiKey),
    hasTushareToken: Boolean(encryptedTushareToken),
    updatedAt,
  });
}
