CREATE TABLE `access_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`client_label` text NOT NULL,
	`allowed_document_ids` text NOT NULL,
	`allowed_collection_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_json` text NOT NULL,
	`action` text NOT NULL,
	`target_record_id` text,
	`timestamp` integer NOT NULL,
	`diff_json` text
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state` blob NOT NULL,
	`created_at` integer NOT NULL
);
