CREATE TABLE `comment_references` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`comment_id` integer NOT NULL,
	`referenced_event_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_references_comment_event_unique` ON `comment_references` (`comment_id`,`referenced_event_id`);--> statement-breakpoint
CREATE INDEX `comment_references_referenced_event_idx` ON `comment_references` (`referenced_event_id`);--> statement-breakpoint
CREATE TABLE `plan_item_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_item_id` integer NOT NULL,
	`content` text NOT NULL,
	`author` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plan_item_comments_plan_item_id_idx` ON `plan_item_comments` (`plan_item_id`);