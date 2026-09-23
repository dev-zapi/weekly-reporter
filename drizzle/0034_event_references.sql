CREATE TABLE `event_references` (
	`event_id` integer NOT NULL,
	`referenced_event_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_references_event_ref_unique` ON `event_references` (`event_id`,`referenced_event_id`);--> statement-breakpoint
CREATE INDEX `event_references_referenced_event_idx` ON `event_references` (`referenced_event_id`);