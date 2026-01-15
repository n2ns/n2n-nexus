import { z } from "zod";

export const StartMeetingSchema = z.object({
    topic: z.string().min(1, "Topic is required")
});

export const EndMeetingSchema = z.object({
    meetingId: z.string().optional(),
    summary: z.string().optional()
});

export const ArchiveMeetingSchema = z.object({
    meetingId: z.string()
});

export const ReopenMeetingSchema = z.object({
    meetingId: z.string()
});
