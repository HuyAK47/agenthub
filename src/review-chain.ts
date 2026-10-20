import { z } from 'zod';

export const ReviewChainStepSchema = z.object({
  reviewer: z.string().min(1).refine((value) => value === 'claude' || value.startsWith('codex:'), {
    message: 'reviewer phải là claude hoặc codex:<model>',
  }),
  mode: z.enum(['gate', 'final']),
});

export const ReviewChainSchema = z.array(ReviewChainStepSchema).max(10);
export type ReviewChainStep = z.infer<typeof ReviewChainStepSchema>;

export function parseReviewChain(value: string | null | undefined): ReviewChainStep[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    const result = ReviewChainSchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function reviewerModel(step: ReviewChainStep): string | null {
  return step.reviewer.startsWith('codex:') ? step.reviewer : null;
}
