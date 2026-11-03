import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { InboxPage } from '@/features/inbox/InboxPage';

/** `c` = the open conversation, `department` = the department tab (mobile M4). */
const inboxSearchSchema = z.object({
  c: z.string().min(1).max(120).optional().catch(undefined),
  department: z.string().min(1).max(40).optional().catch(undefined),
});

export const Route = createFileRoute('/inbox')({
  validateSearch: inboxSearchSchema,
  component: InboxPage,
});
