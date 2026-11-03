import { z } from 'zod';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined);

export const dailyBoardSearchSchema = z.object({ day });
export type DailyBoardSearch = z.infer<typeof dailyBoardSearchSchema>;

export const weeklyBoardSearchSchema = z.object({ week: day });
export type WeeklyBoardSearch = z.infer<typeof weeklyBoardSearchSchema>;

export const salarySearchSchema = z.object({
  kind: z.enum(['week', 'pay_period', 'month']).optional().catch(undefined),
  date: day,
});
export type SalarySearch = z.infer<typeof salarySearchSchema>;
