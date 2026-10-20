export interface AssistantUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextTokens: number;
}

export type ParsedStreamEvent =
  | {
      type: 'init';
      sessionId: string;
    }
  | {
      type: 'text_delta';
      text: string;
    }
  | {
      type: 'assistant_text';
      text: string;
      usage?: AssistantUsage;
    }
  | {
      type: 'tool_use';
      id?: string;
      name: string;
      input?: Record<string, unknown>;
      summary: string;
      usage?: AssistantUsage;
    }
  | {
      type: 'tool_result';
    }
  | {
      type: 'permission_request';
      message?: string;
    }
  | {
      type: 'result';
      sessionId?: string;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      isError: boolean;
      result?: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      };
    }
  | {
      type: 'rate_limit_info';
      status: string;
      resetsAt?: number;
    };

export interface ClaudeQuotaSignal {
  exhausted: boolean;
  resetSeconds?: number;
}

/**
 * Claude's CLI has emitted quota failures both as a result event and on
 * stderr. Keep this deliberately narrow: a generic 429, timeout, or network
 * error is not proof that the usage quota is exhausted.
 */
export function detectClaudeQuota(
  input: { streamText?: string; stderr?: string; exitCode?: number | null },
): ClaudeQuotaSignal {
  const text = `${input.streamText || ''}\n${input.stderr || ''}`;
  const explicit = /(?:usage\s+limit|quota|extra\s+usage|rate\s+limit).*(?:reached|exceeded|exhausted|hit|reset|try again)|(?:reached|exceeded|exhausted|hit).*(?:usage\s+limit|quota)|(?:you(?:'|’)ve\s+hit|you\s+have\s+exhausted).*\b(?:usage\s+)?limit/i.test(text);
  if (!explicit) return { exhausted: false };

  const reset = text.match(/(?:resets?\s+in|try\s+again\s+in)\s+[^\n,.}]+/i);
  if (!reset) return { exhausted: true };
  const parts = reset[0].match(/(\d+)\s*h|(?<![a-z])(\d+)\s*m|(?<![a-z])(\d+)\s*s/gi) || [];
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part.match(/\d+/)?.[0] || 0);
    if (/h/i.test(part)) seconds += value * 3600;
    else if (/m/i.test(part)) seconds += value * 60;
    else seconds += value;
  }
  return { exhausted: true, resetSeconds: seconds > 0 ? seconds + 60 : undefined };
}

export function formatToolSummary(name: string, input?: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') {
    return name;
  }
  if (typeof input.file_path === 'string' && input.file_path) {
    return `${name} ${input.file_path}`;
  }
  if (typeof input.path === 'string' && input.path) {
    return `${name} ${input.path}`;
  }
  if (typeof input.command === 'string' && input.command) {
    return `${name} ${input.command}`;
  }
  if (typeof input.pattern === 'string' && input.pattern) {
    return `${name} ${input.pattern}`;
  }
  if (typeof input.query === 'string' && input.query) {
    return `${name} ${input.query}`;
  }
  if (typeof input.taskId === 'string' && input.taskId) {
    return `${name} ${input.taskId}`;
  }
  return name;
}

export function parseStreamJsonLine(line: string): ParsedStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // Gặp dòng không hợp lệ thì bỏ qua
    return [];
  }

  if (!data || typeof data !== 'object') return [];

  const events: ParsedStreamEvent[] = [];

  // 1. type: "system", subtype: "init"
  if (data.type === 'system' && data.subtype === 'init' && typeof data.session_id === 'string') {
    events.push({
      type: 'init',
      sessionId: data.session_id,
    });
    return events;
  }

  if ((data.type === 'permission_request' || (data.type === 'system' && data.subtype === 'permission_request'))) {
    return [{ type: 'permission_request', message: typeof data.message === 'string' ? data.message : undefined }];
  }

  // 2. type: "assistant"
  if (data.type === 'assistant' && data.message && typeof data.message === 'object') {
    const msg = data.message as Record<string, unknown>;
    let usage: AssistantUsage | undefined;
    if (msg.usage && typeof msg.usage === 'object') {
      const u = msg.usage as Record<string, unknown>;
      const input = Number(u.input_tokens ?? u.inputTokens ?? 0) || 0;
      const output = Number(u.output_tokens ?? u.outputTokens ?? 0) || 0;
      const cacheRead = Number(u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? u.cache_read_tokens ?? 0) || 0;
      const cacheCreation = Number(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? u.cache_creation_tokens ?? 0) || 0;
      usage = {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
        contextTokens: input + cacheRead + cacheCreation,
      };
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          events.push({
            type: 'assistant_text',
            text: block.text,
            ...(usage ? { usage } : {}),
          });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<
            string,
            unknown
          >;
          events.push({
            type: 'tool_use',
            id: typeof block.id === 'string' ? block.id : undefined,
            name: block.name,
            input,
            summary: formatToolSummary(block.name, input),
            ...(usage ? { usage } : {}),
          });
        }
      }
    }
    if (events.length === 0 && usage) {
      events.push({
        type: 'assistant_text',
        text: '',
        usage,
      });
    }
    return events;
  }

  if ((data.type === 'user' || data.type === 'tool_result') && data.message && typeof data.message === 'object') {
    const msg = data.message as Record<string, unknown>;
    if (Array.isArray(msg.content) && msg.content.some((block) => block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_result')) {
      return [{ type: 'tool_result' }];
    }
  }

  if (data.type === 'rate_limit_info' && data.rate_limit_info && typeof data.rate_limit_info === 'object') {
    const info = data.rate_limit_info as Record<string, unknown>;
    if (typeof info.status === 'string') {
      return [{ type: 'rate_limit_info', status: info.status, ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}) }];
    }
  }

  // 3. type: "stream_event" (khi có partial)
  if (data.type === 'stream_event') {
    const ev = (data.event && typeof data.event === 'object' ? data.event : {}) as Record<string, unknown>;
    const delta = (
      ev.delta && typeof ev.delta === 'object'
        ? ev.delta
        : data.delta && typeof data.delta === 'object'
        ? data.delta
        : {}
    ) as Record<string, unknown>;
    const text = typeof delta.text === 'string' ? delta.text : typeof ev.text === 'string' ? ev.text : undefined;
    if (typeof text === 'string' && text.length > 0) {
      events.push({
        type: 'text_delta',
        text,
      });
    }
    return events;
  }

  // 4. type: "result"
  if (data.type === 'result') {
    const isError = Boolean(data.is_error);
    const resultStr = typeof data.result === 'string' ? data.result : undefined;
    let usage:
      | {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
        }
      | undefined;
    if (data.usage && typeof data.usage === 'object') {
      const u = data.usage as Record<string, unknown>;
      const rawInput = Number(u.input_tokens ?? u.inputTokens ?? 0) || 0;
      const cacheRead = Number(u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? u.cache_read_tokens ?? 0) || 0;
      const cacheCreation = Number(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? u.cache_creation_tokens ?? 0) || 0;
      const output = Number(u.output_tokens ?? u.outputTokens ?? 0) || 0;
      const totalInput = rawInput + cacheRead + cacheCreation;
      usage = {
        inputTokens: totalInput,
        outputTokens: output,
        ...(cacheRead > 0 ? { cacheReadInputTokens: cacheRead } : {}),
        ...(cacheCreation > 0 ? { cacheCreationInputTokens: cacheCreation } : {}),
      };
    }
    events.push({
      type: 'result',
      sessionId: typeof data.session_id === 'string' ? data.session_id : undefined,
      costUsd: typeof data.total_cost_usd === 'number' ? data.total_cost_usd : undefined,
      durationMs: typeof data.duration_ms === 'number' ? data.duration_ms : undefined,
      numTurns: typeof data.num_turns === 'number' ? data.num_turns : undefined,
      isError,
      result: resultStr,
      usage,
    });
    return events;
  }

  return events;
}

export class StreamChunkParser {
  private buffer = '';

  feed(chunk: string | Buffer): ParsedStreamEvent[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    const results: ParsedStreamEvent[] = [];
    for (const line of lines) {
      const parsed = parseStreamJsonLine(line);
      if (parsed.length > 0) {
        results.push(...parsed);
      }
    }
    return results;
  }

  flush(): ParsedStreamEvent[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const parsed = parseStreamJsonLine(this.buffer);
    this.buffer = '';
    return parsed;
  }
}
