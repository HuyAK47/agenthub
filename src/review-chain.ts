import { z } from 'zod';
import { isValidReviewerModel } from './reviewer-config.js';

export const ReviewChainStepSchema = z.object({
  reviewer: z
    .string()
    .trim()
    .min(1, 'Reviewer không được để trống')
    .refine(
      (value) => {
        if (value === 'claude') return true;
        if (value.startsWith('codex:')) {
          const model = value.slice('codex:'.length);
          return Boolean(model) && !/\s/.test(value) && isValidReviewerModel('codex', model);
        }
        return false;
      },
      {
        message: 'reviewer phải là claude hoặc codex:<model>',
      },
    ),
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
