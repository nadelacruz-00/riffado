CREATE TABLE "recording_images" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"user_id" text NOT NULL,
	"plaud_image_id" varchar(255) NOT NULL,
	"storage_type" varchar(10) NOT NULL,
	"storage_path" text,
	"mime_type" varchar(100),
	"size_bytes" integer,
	"captured_at" timestamp,
	"offset_ms" integer,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recording_images_recording_id_plaud_image_id_unique" UNIQUE("recording_id","plaud_image_id")
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "images_checked_version" varchar(50);--> statement-breakpoint
ALTER TABLE "recording_images" ADD CONSTRAINT "recording_images_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_images" ADD CONSTRAINT "recording_images_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_images_recording_id_idx" ON "recording_images" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "recording_images_user_id_idx" ON "recording_images" USING btree ("user_id");