CREATE TABLE `event_plan_references` (
	`event_id` integer NOT NULL,
	`plan_item_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_plan_references_event_plan_item_unique` ON `event_plan_references` (`event_id`,`plan_item_id`);--> statement-breakpoint
CREATE INDEX `event_plan_references_plan_item_id_idx` ON `event_plan_references` (`plan_item_id`);