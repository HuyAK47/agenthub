import type { PlatformApi } from './types.js';
import { darwinPlatform } from './darwin.js';
import { linuxPlatform } from './linux.js';

export { darwinPlatform, linuxPlatform };
export type { PlatformApi, PlatformProcessInfo, ServiceInstallResult, ServiceRestartResult, ServiceUninstallResult } from './types.js';

export function getPlatform(): PlatformApi {
  if (process.platform === 'darwin') return darwinPlatform;
  if (process.platform === 'win32') return {
    ...linuxPlatform,
    serviceCheck: () => ({ id: 'platform', name: 'Nền tảng', status: 'error', message: 'Windows không được hỗ trợ. Dùng WSL2 và nhánh Linux để chạy AgentHub.', suggestion: 'Cài WSL2, sau đó chạy AgentHub trong môi trường Linux.', details: { platform: 'win32', supported: false } }),
  };
  return linuxPlatform;
}
