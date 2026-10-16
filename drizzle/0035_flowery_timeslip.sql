CREATE TABLE `period_plan_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period_plan_id` integer NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`project_scope` text DEFAULT 'work' NOT NULL,
	`parent_item_id` integer,
	`deferred_from_item_id` integer,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `period_plan_items_plan_position_idx` ON `period_plan_items` (`period_plan_id`,`position`);--> statement-breakpoint
CREATE INDEX `period_plan_items_parent_item_idx` ON `period_plan_items` (`parent_item_id`);--> statement-breakpoint
CREATE INDEX `period_plan_items_deferred_from_item_idx` ON `period_plan_items` (`deferred_from_item_id`);--> statement-breakpoint
CREATE TABLE `period_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`month_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `period_plans_scope_period_unique` ON `period_plans` (`scope`,`period_start`,`period_end`);--> statement-breakpoint
CREATE UNIQUE INDEX `period_plans_scope_month_key_unique` ON `period_plans` (`scope`,`month_key`);