ALTER TABLE `snapshots` ADD `workspace_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `shard_id` text DEFAULT 'default' NOT NULL;