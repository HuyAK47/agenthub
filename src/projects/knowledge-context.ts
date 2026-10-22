import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeEntryRow } from '../db/index.js';

export const MAX_REFERENCE_BYTES = 64 * 1024;
export const MAX_PROJECT_KNOWLEDGE_BYTES = 128 * 1024;

export interface KnowledgeReference {
  name: string;
  path: string;
  inject?: boolean;
}
export interface ProjectKnowledgeContext {
  text: string;
  hash: string;
  truncated: string[];
}
function readReference(reference: KnowledgeReference, projectPath?: string): { content?: string; reason?: string; size?: number } {
  try {
    const referencePath = projectPath && !path.isAbsolute(reference.path) ? path.resolve(projectPath, reference.path) : reference.path;
    const stat = fs.statSync(referencePath);
    if (!stat.isFile()) return { reason: 'không phải file' };
    if (stat.size > MAX_REFERENCE_BYTES) return { reason: `vượt giới hạn 64KB (${stat.size} bytes)`, size: stat.size };
    return { content: fs.readFileSync(referencePath, 'utf8'), size: stat.size };
  } catch {
    return { reason: 'không thể đọc' };
  }
}

function truncateUtf8(value: string, bytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= bytes) return value;
  let result = value.slice(0, Math.max(0, bytes));
  while (Buffer.byteLength(result, 'utf8') > bytes) result = result.slice(0, -1);
  return result;
}

/** Builds the bounded project context shared by brain, assistant and workers. */
export function buildProjectKnowledgeContext(
  entries: KnowledgeEntryRow[],
  references: KnowledgeReference[],
  maxBytes = MAX_PROJECT_KNOWLEDGE_BYTES,
  projectPath?: string,
): ProjectKnowledgeContext {
  const sections: string[] = ['# KIẾN THỨC DỰ ÁN', '', '## Kiến thức ghim'];
  for (const entry of entries.filter((item) => item.pinned === 1)) {
    sections.push(`- ${entry.content} _(task: ${entry.taskId})`);
  }
  if (!entries.some((item) => item.pinned === 1)) sections.push('- Không có');
  sections.push('', '## Tham chiếu inject');
  const truncated: string[] = [];
  for (const reference of references.filter((item) => item.inject)) {
    const result = readReference(reference, projectPath);
    sections.push(`### ${reference.name}`, `- Đường dẫn: ${reference.path}`);
    if (result.content !== undefined) {
      sections.push('```', result.content, '```');
    } else {
      sections.push(`- CẢNH BÁO: ${result.reason}. Bộ não có thể tự đọc đường dẫn khi cần.`);
      if (result.reason?.startsWith('vượt')) truncated.push(reference.path);
    }
    sections.push('');
  }
  if (!references.some((item) => item.inject)) sections.push('- Không có');
  if (truncated.length > 0) {
    sections.push(`CẢNH BÁO: nội dung đã cắt/không inject vì vượt giới hạn 64KB; tự đọc: ${truncated.join(', ')}`);
  }

  const full = sections.join('\n');
  let text = full;
  if (Buffer.byteLength(full, 'utf8') > maxBytes) {
    const note = `\n\n[CẢNH BÁO: KIẾN THỨC DỰ ÁN đã bị cắt vì vượt ${maxBytes} bytes; tự đọc các đường dẫn tham chiếu ở trên.]`;
    text = truncateUtf8(full, Math.max(0, maxBytes - Buffer.byteLength(note, 'utf8'))) + note;
    truncated.push(...references.filter((item) => item.inject).map((item) => item.path));
  }
  return {
    text,
    hash: crypto.createHash('sha256').update(full).digest('hex'),
    truncated: [...new Set(truncated)],
  };
}
