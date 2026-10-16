#!/usr/bin/env node

import fs from 'node:fs';

const args = process.argv.slice(2);

// Support --help
if (args.includes('--help')) {
  console.log('Claude CLI Mock');
  console.log('  --include-partial-messages            Include partial message chunks as they');
  console.log('  -p <text>                             Prompt text');
  console.log('  --output-format <format>              Output format (stream-json)');
  process.exit(0);
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return '';
  }
  let data = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

const resumeIdx = args.indexOf('--resume');
const resumeSessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : 'sess-default-123';

async function main() {
  const stdin = await readStdin();
  const pIdx = args.indexOf('-p');
  let prompt = stdin;
  if (!prompt && pIdx >= 0 && args[pIdx + 1] && !args[pIdx + 1].startsWith('-')) {
    prompt = args[pIdx + 1];
  }

  // Log arguments if FAKE_CLAUDE_LOG is specified
  if (process.env.FAKE_CLAUDE_LOG) {
    try {
      fs.appendFileSync(
        process.env.FAKE_CLAUDE_LOG,
        JSON.stringify({
          argv: process.argv,
          stdin,
          cwd: process.cwd(),
          env: { FAKE_MODE: process.env.FAKE_MODE, ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH },
        }) + '\n',
        'utf-8',
      );
    } catch {
      // ignore
    }
  }

  if (prompt.includes('sleep')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-sleep' }));
    await new Promise((resolve) => setTimeout(resolve, 30000));
    return;
  }

  if (prompt.includes('tool')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tool-123' }));
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Read',
              input: { file_path: 'docs/PLAN.md' },
            },
          ],
        },
      }),
    );
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Nội dung PLAN đã đọc.',
            },
          ],
        },
      }),
    );
    console.log(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-tool-123',
        total_cost_usd: 0.002,
        duration_ms: 200,
        num_turns: 2,
        is_error: false,
        result: 'Nội dung PLAN đã đọc.',
      }),
    );
    return;
  }

  if (prompt.includes('error')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-err-123' }));
    console.log(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-err-123',
        is_error: true,
        result: 'Rate limit exceeded',
      }),
    );
    return;
  }

  if (prompt.includes('corrupt')) {
    console.log('not valid json at all');
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-corrupt-123' }));
    console.log('another corrupt line {{{');
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Vẫn parse được sau dòng lỗi.',
            },
          ],
        },
      }),
    );
    console.log(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-corrupt-123',
        total_cost_usd: 0.001,
        duration_ms: 100,
        num_turns: 1,
        is_error: false,
        result: 'Vẫn parse được sau dòng lỗi.',
      }),
    );
    return;
  }

  // Normal flow
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: resumeSessionId }));
  console.log(
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Xin chào, ' },
      },
    }),
  );
  console.log(
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'tôi là Claude!' },
      },
    }),
  );
  console.log(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'Xin chào, tôi là Claude!',
          },
        ],
      },
    }),
  );
  console.log(
    JSON.stringify({
      type: 'result',
      session_id: resumeSessionId,
      total_cost_usd: 0.0015,
      duration_ms: 150,
      num_turns: 1,
      is_error: false,
      result: 'Xin chào, tôi là Claude!',
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
