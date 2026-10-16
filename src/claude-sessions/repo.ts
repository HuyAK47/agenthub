import Database from 'better-sqlite3';

export interface ClaudeSessionRow { sessionId: string; cwd: string; title: string | null; firstAt: string | null; lastAt: string | null; model: string | null; messages: number; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; effectiveTokens: number; isHubChat: number }
export interface ClaudeUsageRow { sessionId: string; messageId: string; ts: string; turnId: string; model: string | null; input: number; output: number; cacheCreation: number; cacheRead: number; effective: number; isSidechain: number }

export class ClaudeSessionRepo {
  constructor(private db: Database.Database) {}
  get(id: string) { return this.db.prepare('SELECT * FROM claude_sessions WHERE sessionId = ?').get(id) as ClaudeSessionRow | undefined; }
  list() { return this.db.prepare('SELECT * FROM claude_sessions ORDER BY lastAt DESC').all() as ClaudeSessionRow[]; }
  upsert(row: Partial<ClaudeSessionRow> & Pick<ClaudeSessionRow, 'sessionId' | 'cwd'>) {
    this.db.prepare(`INSERT INTO claude_sessions (sessionId,cwd,title,firstAt,lastAt,model,messages,inputTokens,outputTokens,cacheCreationTokens,cacheReadTokens,effectiveTokens,isHubChat) VALUES (@sessionId,@cwd,@title,@firstAt,@lastAt,@model,@messages,@inputTokens,@outputTokens,@cacheCreationTokens,@cacheReadTokens,@effectiveTokens,@isHubChat) ON CONFLICT(sessionId) DO UPDATE SET cwd=excluded.cwd,title=COALESCE(excluded.title,claude_sessions.title),firstAt=COALESCE(claude_sessions.firstAt,excluded.firstAt),lastAt=MAX(claude_sessions.lastAt,excluded.lastAt),model=COALESCE(excluded.model,claude_sessions.model),messages=excluded.messages,inputTokens=excluded.inputTokens,outputTokens=excluded.outputTokens,cacheCreationTokens=excluded.cacheCreationTokens,cacheReadTokens=excluded.cacheReadTokens,effectiveTokens=excluded.effectiveTokens,isHubChat=excluded.isHubChat`).run({ title: null, firstAt: null, lastAt: null, model: null, messages: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, effectiveTokens: 0, isHubChat: 0, ...row });
  }
  addUsage(row: ClaudeUsageRow) { return this.db.prepare('INSERT OR IGNORE INTO claude_usage VALUES (@sessionId,@messageId,@ts,@turnId,@model,@input,@output,@cacheCreation,@cacheRead,@effective,@isSidechain)').run(row); }
  usage(sessionId: string) { return this.db.prepare('SELECT * FROM claude_usage WHERE sessionId = ? ORDER BY ts').all(sessionId) as ClaudeUsageRow[]; }
  turnTotal(sessionId: string, turnId: string) {
    return this.db.prepare('SELECT COALESCE(SUM(effective),0) effective FROM claude_usage WHERE sessionId=? AND turnId=?').get(sessionId, turnId) as { effective: number };
  }
  setTasks(sessionId: string, turnId: string, rows: Array<{ taskId: string; effectiveTokens: number }>) { const del = this.db.prepare('DELETE FROM claude_task_usage WHERE sessionId=? AND turnId=?'); const ins = this.db.prepare('INSERT INTO claude_task_usage VALUES (?,?,?,?)'); const tx = this.db.transaction(() => { del.run(sessionId, turnId); for (const row of rows) ins.run(row.taskId, sessionId, turnId, row.effectiveTokens); }); tx(); }
  topTasks(sessionId: string, limit = 5) { return this.db.prepare('SELECT taskId, SUM(effectiveTokens) effectiveTokens FROM claude_task_usage WHERE sessionId=? GROUP BY taskId ORDER BY effectiveTokens DESC LIMIT ?').all(sessionId, limit) as Array<{taskId:string; effectiveTokens:number}>; }
  taskCost(taskId: string) { return this.db.prepare('SELECT COALESCE(SUM(effectiveTokens),0) effectiveTokens, COUNT(DISTINCT sessionId) sessions FROM claude_task_usage WHERE taskId=?').get(taskId) as { effectiveTokens: number; sessions: number }; }
  quota() { return this.db.prepare('SELECT status,resetsAt,rateLimitType,observedAt FROM claude_quota WHERE id=1').get() as {status:string|null;resetsAt:number|null;rateLimitType:string|null;observedAt:string}|undefined; }
  setQuota(row: {status:string;resetsAt:number|null;rateLimitType:string|null;isUsingOverage:boolean;observedAt:string}) { this.db.prepare('INSERT OR REPLACE INTO claude_quota VALUES (1,?,?,?,?,?)').run(row.status,row.resetsAt,row.rateLimitType,row.isUsingOverage?1:0,row.observedAt); }
}
