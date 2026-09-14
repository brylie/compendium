CREATE TABLE `synced_block_instance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`source_record_id` text NOT NULL,
	`instance_record_id` text NOT NULL,
	`instance_shard_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `synced_block_instance_workspace_instance_unique` ON `synced_block_instance` (`workspace_id`,`instance_record_id`);--> statement-breakpoint
CREATE INDEX `synced_block_instance_workspace_source` ON `synced_block_instance` (`workspace_id`,`source_record_id`);--> statement-breakpoint
CREATE INDEX `synced_block_instance_workspace_shard` ON `synced_block_instance` (`workspace_id`,`instance_shard_id`);