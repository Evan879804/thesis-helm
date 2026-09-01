import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const providerSettings = sqliteTable("provider_settings", {
  userId: text("user_id").primaryKey(),
  provider: text("provider").notNull().default("deepseek"),
  baseUrl: text("base_url").notNull().default("https://api.deepseek.com"),
  model: text("model").notNull().default("deepseek-v4-flash"),
  encryptedApiKey: text("encrypted_api_key"),
  encryptedSearchApiKey: text("encrypted_search_api_key"),
  encryptedTushareToken: text("encrypted_tushare_token"),
  updatedAt: text("updated_at").notNull(),
});
