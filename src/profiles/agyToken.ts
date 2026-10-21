import fs from 'node:fs';
import path from 'node:path';

const AGY_CLIENT_ID_BYTES = [6,7,0,6,7,7,1,7,1,7,2,14,6,26,67,90,95,68,68,94,89,5,95,5,6,91,84,69,82,5,4,2,65,67,88,91,88,93,95,3,80,3,7,4,82,71,25,86,71,71,68,25,80,88,88,80,91,82,66,68,82,69,84,88,89,67,82,89,67,25,84,88,90];
const AGY_CLIENT_SECRET_BYTES = [112,120,116,100,103,111,26,124,2,15,113,96,101,3,15,1,123,83,123,125,6,90,123,117,15,68,111,116,3,77,1,70,115,118,81];

function xorDecode(bytes: number[], mask = 0x37): string {
  return Buffer.from(bytes.map((b) => b ^ mask)).toString('utf8');
}

export function getAgyGoogleClientId(): string {
  return process.env.AGENTHUB_AGY_CLIENT_ID || xorDecode(AGY_CLIENT_ID_BYTES);
}

export function getAgyGoogleClientSecret(): string {
  return process.env.AGENTHUB_AGY_CLIENT_SECRET || xorDecode(AGY_CLIENT_SECRET_BYTES);
}

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface ExchangedTokenData {
  accessToken: string;
  tokenType: string;
  refreshToken: string;
  expiry: string;
}

/**
 * Trao đổi Antigravity refresh_token với Google OAuth để lấy access_token mới và kiểm tra tính hợp lệ của token.
 */
export async function exchangeAgyRefreshToken(
  refreshToken: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ExchangedTokenData> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const signal = options?.signal ?? AbortSignal.timeout(timeoutMs);

  const body = new URLSearchParams({
    client_id: getAgyGoogleClientId(),
    client_secret: getAgyGoogleClientSecret(),
    refresh_token: refreshToken.trim(),
    grant_type: 'refresh_token',
  });

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Không thể kết nối tới Google OAuth endpoint: ${message}`);
  }

  let data: Record<string, unknown> | null = null;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Phản hồi không hợp lệ từ Google OAuth (HTTP ${response.status})`);
  }

  if (!response.ok) {
    const errorMsg = String(data?.error_description || data?.error || `HTTP ${response.status}`);
    if (data?.error === 'invalid_grant') {
      throw new Error(`Refresh token không hợp lệ hoặc đã bị thu hồi/hết hạn (${errorMsg})`);
    }
    throw new Error(`Google OAuth từ chối xác thực: ${errorMsg}`);
  }

  const accessToken = typeof data?.access_token === 'string' ? data.access_token : '';
  if (!accessToken) {
    throw new Error('Google OAuth phản hồi thành công nhưng không chứa access_token');
  }

  const expiresInSec = typeof data?.expires_in === 'number' ? data.expires_in : 3600;
  const expiry = new Date(Date.now() + expiresInSec * 1000).toISOString();

  return {
    accessToken,
    tokenType: typeof data?.token_type === 'string' ? data.token_type : 'Bearer',
    refreshToken: refreshToken.trim(),
    expiry,
  };
}

/**
 * Ghi cấu trúc token Antigravity CLI và log xác thực vào thư mục isolated home của profile.
 * Đảm bảo quyền bảo mật nghiêm ngặt: thư mục 0700, file 0600.
 */
export function writeAgyIsolatedToken(
  profileHome: string,
  tokenData: {
    accessToken?: string;
    refreshToken: string;
    tokenType?: string;
    expiry?: string;
  },
  email?: string | null,
): void {
  const cliDir = path.join(profileHome, '.gemini', 'antigravity-cli');
  if (!fs.existsSync(cliDir)) {
    fs.mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(cliDir, 0o700);
    } catch {
      // ignore
    }
  }

  const tokenPayload = {
    access_token: tokenData.accessToken || '',
    token_type: tokenData.tokenType || 'Bearer',
    refresh_token: tokenData.refreshToken,
    expiry: tokenData.expiry || new Date(Date.now() + 3600 * 1000).toISOString(),
  };

  const tokenFilePath = path.join(cliDir, 'antigravity-oauth-token');
  fs.writeFileSync(tokenFilePath, JSON.stringify(tokenPayload, null, 2) + '\n', {
    mode: 0o600,
  });
  try {
    fs.chmodSync(tokenFilePath, 0o600);
  } catch {
    // ignore
  }

  // Ghi log giả lập để ProfileService.readEmailFromLog() nhận diện được email ngay lập tức
  if (email && email.trim()) {
    const cleanEmail = email.trim();
    const logDir = path.join(cliDir, 'log');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    }
    const logFilePath = path.join(logDir, 'auth.log');
    const logContent = `[${new Date().toISOString()}] authenticated successfully as ${cleanEmail}\n`;
    // Ghi đè (không append): readEmailFromLog lấy match đầu tiên trong file, append sẽ giữ email cũ.
    fs.writeFileSync(logFilePath, logContent, { mode: 0o600 });
    try {
      fs.chmodSync(logFilePath, 0o600);
    } catch {
      // ignore
    }
  }
}

export interface GoogleUserInfo {
  sub?: string;
  email?: string;
  name?: string;
  picture?: string;
}

/**
 * Lấy thông tin tài khoản Google (bao gồm picture / avatar) từ Google OAuth userinfo endpoint.
 */
export async function fetchAgyGoogleUserInfo(
  accessToken: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<GoogleUserInfo | null> {
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const signal = options?.signal ?? AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    return {
      sub: typeof data.sub === 'string' ? data.sub : undefined,
      email: typeof data.email === 'string' ? data.email : undefined,
      name: typeof data.name === 'string' ? data.name : undefined,
      picture: typeof data.picture === 'string' ? data.picture : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Đọc file token Antigravity từ thư mục profile home nếu có.
 */
export function readAgyToken(profileHome: string): {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiry?: string;
} | null {
  const tokenFile = path.join(profileHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  if (!fs.existsSync(tokenFile)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as Record<string, unknown>;
    return {
      accessToken: typeof raw.access_token === 'string' ? raw.access_token : undefined,
      refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
      tokenType: typeof raw.token_type === 'string' ? raw.token_type : undefined,
      expiry: typeof raw.expiry === 'string' ? raw.expiry : undefined,
    };
  } catch {
    return null;
  }
}
