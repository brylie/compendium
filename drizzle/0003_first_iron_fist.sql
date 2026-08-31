CREATE TABLE `migration_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`legacy_snapshot_id` text NOT NULL,
	`migration_version` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `migration_runs_identity_unique` ON `migration_runs` (`workspace_id`,`legacy_snapshot_id`,`migration_version`);--> statement-breakpoint
CREATE TABLE `migration_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`legacy_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_shard_id` text NOT NULL,
	`checksum` text,
	`durable` integer DEFAULT false NOT NULL,
	`migrated_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `migration_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `migration_targets_run_legacy_unique` ON `migration_targets` (`run_id`,`legacy_id`);