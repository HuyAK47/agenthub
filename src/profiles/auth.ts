import { ProfileAuthState } from '../db/index.js';

export interface AuthStateResult {
  authState: ProfileAuthState;
  authMessage: string | null;
  verifyUrl: string | null;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;

/**
 * Extract Google accounts verification URL from CLI output.
 * If the URL is broken across multiple lines (e.g. terminal wrapping), stitches it together.
 */
export function extractVerifyUrl(raw: string): string | null {
  const text = raw.replace(ANSI_RE, '').replace(/\r/g, '');

  const startIdx = text.indexOf('https://accounts.google.com/');
  if (startIdx === -1) return null;

  const after = text.slice(startIdx);
  const lines = after.split('\n');

  let url = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      const token = line.trim().split(/\s+/)[0];
      url = token;
    } else {
      const trimmed = line.trim();
      if (!trimmed) break;
      // If line contains spaces, only accept if the previous URL part was abruptly broken
      if (
        trimmed.includes(' ') &&
        !url.endsWith('&') &&
        !url.endsWith('=') &&
        !url.endsWith('?') &&
        !url.endsWith('%')
      ) {
        break;
      }
      const token = trimmed.split(/\s+/)[0];
      // Valid URL characters in query strings
      if (/^[a-zA-Z0-9_.~:/?#[\]@!$&'()*+,;=%-]+$/.test(token)) {
        url += token;
        if (trimmed.includes(' ')) {
          break;
        }
      } else {
        break;
      }
    }
  }

  // Strip trailing punctuation often left from sentences or quotes
  url = url.replace(/["'>)]+$/, '');
  return url || null;
}

/**
 * Parse output from agy usage or check command to determine authState.
 */
export function parseAuthState(output: string, hasUsage = false): AuthStateResult {
  if (/not eligible|Verify your account|Eligibility check failed/i.test(output)) {
    return {
      authState: 'needs_verification',
      authMessage: 'Cần xác minh tài khoản',
      verifyUrl: extractVerifyUrl(output),
    };
  }

  if (/not logged in|authentication/i.test(output)) {
    return {
      authState: 'not_logged_in',
      authMessage: 'Chưa đăng nhập hoặc xác thực thất bại',
      verifyUrl: null,
    };
  }

  if (hasUsage) {
    return {
      authState: 'ok',
      authMessage: null,
      verifyUrl: null,
    };
  }

  return {
    authState: 'error',
    authMessage: null,
    verifyUrl: null,
  };
}
