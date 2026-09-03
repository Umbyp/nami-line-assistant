import type { webhook } from '@line/bot-sdk';

/** payload ของ job ใน queue nami:events */
export interface EventJobData {
  event: webhook.Event;
  /** เวลาที่ webhook เข้ามา (ISO UTC) ใช้วัด latency */
  receivedAt: string;
}

/** payload ของ job ใน queue nami:reminder-fire */
export interface FireJobData {
  occurrenceId: string;
}

export const EVENT_JOB = 'line-event';
export const FIRE_JOB = 'fire-occurrence';
