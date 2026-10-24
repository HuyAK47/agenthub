export const VALID_AGY_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

export const DEFAULT_VALID_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'codex:gpt-5.6-luna',
  'gpt-oss-120b-medium',
];

export const DEFAULT_CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'];

export const DEFAULT_CODEX_MODELS = ['gpt-5.6-luna', 'gpt-5.6-turbo'];

export const DEFAULT_COMMON_BRANCHES = ['integration', 'main', 'master', 'develop', 'staging'];

export function validateModelSyntax(
  model: string,
  t?: (key: string) => string,
): string | null {
  const trimmed = model.trim();
  if (!trimmed) {
    return t ? t('settings.emptyChainWarning') : 'Model không được để trống';
  }
  const isAgy = VALID_AGY_MODELS.includes(trimmed);
  const isCodex = trimmed.startsWith('codex:') && trimmed.length > 6;

  if (!isAgy && !isCodex) {
    return t
      ? t('settings.invalidModelSyntax')
      : 'Mỗi model phải là id agy hợp lệ hoặc có tiền tố codex:';
  }
  return null;
}

export function validateChatModelSyntax(
  model: string,
  t?: (key: string) => string,
): string | null {
  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }
  if (!DEFAULT_CLAUDE_MODELS.includes(trimmed)) {
    return t
      ? t('settings.invalidChatModelSyntax')
      : 'Model chat phải là sonnet, opus hoặc haiku';
  }
  return null;
}

export function validateReviewChainReviewerSyntax(
  reviewer: string,
  t?: (key: string) => string,
): string | null {
  const trimmed = reviewer.trim();
  if (!trimmed) {
    return t ? t('settings.emptyChainWarning') : 'Reviewer không được để trống';
  }
  if (/\s/.test(trimmed)) {
    return t ? t('settings.invalidModelSyntax') : 'Reviewer không được chứa khoảng trắng';
  }
  if (trimmed === 'claude') {
    return null;
  }
  if (trimmed.startsWith('codex:')) {
    const codexModel = trimmed.slice('codex:'.length);
    if (!codexModel) {
      return t
        ? t('settings.invalidReviewChainReviewer')
        : 'Reviewer phải là claude hoặc có tiền tố codex:';
    }
    const modelError = validateReviewerModelSyntax(codexModel, 'codex', t);
    if (modelError) {
      return t
        ? t('settings.invalidReviewChainReviewer')
        : 'Reviewer phải là claude hoặc có tiền tố codex:';
    }
    return null;
  }
  return t
    ? t('settings.invalidReviewChainReviewer')
    : 'Reviewer phải là claude hoặc có tiền tố codex:';
}

export function validateBranchSyntax(
  branch: string,
  t?: (key: string) => string,
): string | null {
  const trimmed = branch.trim();
  if (!trimmed) {
    return t ? t('projects.nameRequired') : 'Tên nhánh không được để trống';
  }
  if (
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.includes('//') ||
    trimmed.includes('..') ||
    trimmed.includes('@{') ||
    /[~^:?*[\\ ]/.test(trimmed) ||
    trimmed.endsWith('.lock')
  ) {
    return t
      ? t('settings.invalidBranchSyntax')
      : 'Tên nhánh không hợp lệ hoặc chứa ký tự đặc biệt';
  }
  return null;
}

export function validateReviewerModelSyntax(
  model: string,
  engine?: 'codex' | 'claude' | string,
  t?: (key: string) => string,
): string | null {
  const trimmed = model.trim();
  if (!trimmed) {
    return t ? t('settings.emptyChainWarning') : 'Model reviewer không được để trống';
  }
  if (/\s/.test(trimmed)) {
    return t ? t('settings.invalidModelSyntax') : 'Model không được chứa khoảng trắng';
  }
  if (engine === 'claude') {
    const raw = trimmed.startsWith('claude:') ? trimmed.slice('claude:'.length) : trimmed;
    const isValidClaude =
      DEFAULT_CLAUDE_MODELS.includes(raw) ||
      raw.startsWith('claude-');
    if (!isValidClaude) {
      return t
        ? t('settings.invalidChatModelSyntax')
        : 'Model Claude phải là sonnet, opus hoặc haiku';
    }
  }
  if (engine === 'codex') {
    const raw = trimmed.startsWith('codex:') ? trimmed.slice('codex:'.length) : trimmed;
    const isValidCodex =
      DEFAULT_CODEX_MODELS.includes(raw) ||
      (raw.startsWith('gpt-') && raw.length > 4);
    if (!isValidCodex) {
      return t
        ? t('settings.invalidModelSyntax')
        : 'Model Codex phải có tiền tố codex: hoặc gpt-';
    }
  }
  return null;
}
