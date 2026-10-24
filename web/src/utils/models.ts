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
  const isAgy = DEFAULT_VALID_MODELS.includes(trimmed);
  const isCodex = trimmed.startsWith('codex:') && trimmed.length > 6;
  const isClaude = trimmed.startsWith('claude:') || DEFAULT_CLAUDE_MODELS.includes(trimmed);
  const isGeminiOrGpt = trimmed.startsWith('gemini-') || trimmed.startsWith('gpt-');

  if (!isAgy && !isCodex && !isClaude && !isGeminiOrGpt) {
    return t
      ? t('settings.invalidModelSyntax')
      : 'Mỗi model phải là id hợp lệ hoặc có tiền tố codex:';
  }
  return null;
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
  if (engine && engine.length === 0) {
    return null;
  }
  return null;
}
