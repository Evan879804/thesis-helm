CREATE TABLE `provider_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'deepseek' NOT NULL,
	`base_url` text DEFAULT 'https://api.deepseek.com' NOT NULL,
	`model` text DEFAULT 'deepseek-v4-flash' NOT NULL,
	`encrypted_api_key` text,
	`updated_at` text NOT NULL
);
