// move-session.js — 单次把会话移动到目标工作区目录。
//
// 用法（按「会话路径 + 名称」定位）：
//   node move-session.js "<会话当前工作区路径>" "<会话名称>" "<目标工作区路径>" [--apply]
// 用法（按会话 id 定位）：
//   node move-session.js --id "<session-id>" "<目标工作区路径>" [--apply]
// 列出某目录下的所有会话（便于找到准确的「名称」）：
//   node move-session.js --list "<工作区路径>"
//
// 默认只做 dry-run（打印计划、校验一切、不落盘）；加 --apply 才真正移动。
// 移动内容：重写会话日志头里的 cwd（只动第一个 zstd 帧，事件帧逐字节保留）→
// 移动日志文件 → 更新 workspace.json 的会话归属 → 更新 session_projcache.json 的 cwd。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const APPLY = process.argv.includes("--apply");
const argv = process.argv.slice(2).filter((a) => a !== "--apply");

// 可被环境变量覆盖（便于在副本上演练）
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SESSION_ROOT = process.env.DSH_SESSION_ROOT || path.join(DSH_HOME, "sessions");
const STORAGE_DIR = process.env.DSH_STORAGE_DIR || path.join(DSH_HOME, "storages");
const BACKUP_ROOT = process.env.DSH_MIGRATE_BACKUP_DIR || path.join(path.dirname(STORAGE_DIR), "session-migrate-backups");

const WORKSPACE_PATH = path.join(STORAGE_DIR, "workspace.json");
const PROJCACHE_PATH = path.join(STORAGE_DIR, "session_projcache.json");

// ---------------- 路径助手（与 dsh-session-persistence-jsonl 一致） ----------------
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return "--" + (readable.replace(/^-+/, "") || "root").slice(0, 251) + "--";
}

function logPath(cwd, id) {
  return path.join(SESSION_ROOT, projectKey(cwd), encodeSegment(id), "session.jsonl.zstd");
}

// ---------------- zstd 帧扫描（与 dsh-session-persistence-jsonl 一致） ----------------
const ZSTD_MAGIC = 4247762216;
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

const CHECKSUM_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

function normPath(p) {
  return String(p).replace(/\\/g, "/").toLowerCase();
}

function fail(msg) {
  console.error("ERROR: " + msg);
  process.exit(1);
}

function usage() {
  console.error('用法: node move-session.js "<会话路径>" "<会话名称>" "<目标工作区路径>" [--apply]');
  console.error('      node move-session.js --id "<session-id>" "<目标工作区路径>" [--apply]');
  console.error('      node move-session.js --list "<工作区路径>"');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function backupDir() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(BACKUP_ROOT, "backup-" + ts);
}

// 读取 projcache 里的所有会话（id -> { cwd, title }）
function listSessions() {
  const pc = readJson(PROJCACHE_PATH);
  const out = [];
  for (const [id, s] of Object.entries(pc.tables.sessions)) {
    out.push({ id, cwd: s.identity.cwd, title: s.rows.title && s.rows.title.val });
  }
  return out;
}

// 重写日志头 cwd，返回新文件字节
function rewriteHeaderCwd(oldLog, sessionId, newCwd) {
  const buf = fs.readFileSync(oldLog);
  const { frames, tornStart } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error("no complete zstd frames");
  if (tornStart !== undefined) throw new Error(`trailing incomplete frame at byte ${tornStart}`);
  const first = frames[0];
  const headerPlain = zlib.zstdDecompressSync(buf.subarray(first.start, first.end));
  const headerText = headerPlain.toString("utf8");
  if (headerText.indexOf("\n") !== headerText.length - 1) throw new Error("first frame is not exactly one header line");
  const header = JSON.parse(headerText.trimEnd());
  if (header.type !== "session" || header.id !== sessionId) throw new Error("log header id mismatch");
  const newHeaderFrame = zlib.zstdCompressSync(
    Buffer.from(JSON.stringify({ ...header, cwd: newCwd }) + "\n", "utf8"),
    CHECKSUM_OPTS,
  );
  return Buffer.concat([newHeaderFrame, buf.subarray(first.end)]);
}

// 更新 workspace.json：把会话从旧工作区移除、挂到目标工作区（不存在则注册）
function updateWorkspace(sessionId, targetCwd) {
  const ws = readJson(WORKSPACE_PATH);
  const records = ws.tables.workspaces;
  const accounting = Object.entries(records)
    .filter(([, rec]) => rec.sessionIds.includes(sessionId))
    .map(([id]) => id);
  let targetId = null;
  for (const [id, rec] of Object.entries(records)) {
    if (normPath(rec.path) === normPath(targetCwd)) targetId = id;
  }
  const now = new Date().toISOString();
  if (targetId === null) {
    targetId = crypto.randomUUID();
    records[targetId] = {
      path: targetCwd,
      title: targetCwd.split(/[\\/]/).filter(Boolean).pop() || targetCwd,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    ws.global.workspaceIds = [targetId, ...ws.global.workspaceIds];
    console.log(`[workspace] 注册新工作区 '${targetId}' = ${targetCwd}`);
  }
  if (records[targetId].sessionIds.includes(sessionId)) fail("会话已在目标工作区中");
  for (const id of accounting) {
    records[id].sessionIds = records[id].sessionIds.filter((s) => s !== sessionId);
    records[id].updatedAt = now;
  }
  records[targetId].sessionIds = [sessionId, ...records[targetId].sessionIds];
  records[targetId].updatedAt = now;
  return ws;
}

// ---------------- 主流程 ----------------
async function main() {
  if (argv[0] === "--list") {
    const cwd = argv[1];
    if (!cwd) { usage(); process.exit(1); }
    console.log(`目录 "${cwd}" 下的会话：`);
    const found = listSessions().filter((s) => s.cwd && normPath(s.cwd) === normPath(cwd));
    if (found.length === 0) console.log("  （无）");
    for (const s of found) console.log(`  ${s.id}  名称=${JSON.stringify(s.title ?? "")}`);
    return;
  }

  let sessionId, sessionName, oldCwd, targetCwd;
  if (argv[0] === "--id") {
    sessionId = argv[1];
    targetCwd = argv[2];
  } else {
    oldCwd = argv[0];
    sessionName = argv[1];
    targetCwd = argv[2];
  }
  if (targetCwd === undefined) { usage(); process.exit(1); }

  // 定位会话
  const sessions = listSessions();
  if (sessionId === undefined) {
    for (const s of sessions) {
      if (s.cwd && normPath(s.cwd) === normPath(oldCwd) && s.title === sessionName) {
        sessionId = s.id;
        break;
      }
    }
    if (sessionId === undefined) {
      console.error(`找不到会话：路径="${oldCwd}" 名称="${sessionName}"`);
      console.error("可用 --list \"" + oldCwd + "\" 查看该目录下的会话名称。");
      process.exit(1);
    }
  }
  const sess = sessions.find((s) => s.id === sessionId);
  if (!sess) fail(`projcache 中没有会话 ${sessionId}`);
  oldCwd = sess.cwd;
  sessionName = sess.title ?? sessionName;

  // 目标目录校验 + 规范化
  let canonicalTarget;
  try {
    canonicalTarget = fs.realpathSync(targetCwd);
  } catch (e) {
    fail(`目标工作区路径不存在：${targetCwd}`);
  }
  if (!fs.statSync(canonicalTarget).isDirectory()) fail(`目标路径不是目录：${targetCwd}`);
  targetCwd = canonicalTarget;

  if (normPath(oldCwd) === normPath(targetCwd)) fail("会话已在目标工作区中");

  const oldLog = logPath(oldCwd, sessionId);
  const newLog = logPath(targetCwd, sessionId);
  if (!fs.existsSync(oldLog)) fail("会话日志不存在：" + oldLog);
  if (fs.existsSync(newLog)) fail("目标位置已有会话日志：" + newLog);

  console.log("会话 :", sessionId, `名称=${JSON.stringify(sessionName)}`);
  console.log("原cwd:", oldCwd);
  console.log("新cwd:", targetCwd);
  console.log("模式 :", APPLY ? "APPLY" : "dry-run");
  console.log("");

  const newBuf = rewriteHeaderCwd(oldLog, sessionId, targetCwd);
  // 校验重写结果
  const check = scanZstdFrames(newBuf);
  if (check.tornStart !== undefined) fail("重写后的日志有残缺帧");
  const rebuiltHeader = JSON.parse(zlib.zstdDecompressSync(newBuf.subarray(0, check.frames[0].end)).toString("utf8").trimEnd());
  if (rebuiltHeader.cwd !== targetCwd) fail("重写后头部 cwd 不正确");
  console.log(`[log] 头部重写校验通过（${check.frames.length} 帧），cwd -> ${JSON.stringify(targetCwd)}`);

  const wsNext = updateWorkspace(sessionId, targetCwd);
  console.log(`[workspace] 移动 ${sessionId} -> 工作区 ${targetCwd}`);

  const pcNext = readJson(PROJCACHE_PATH);
  pcNext.tables.sessions[sessionId].identity.cwd = targetCwd;
  console.log(`[projcache] identity.cwd -> ${JSON.stringify(targetCwd)}`);

  if (!APPLY) {
    console.log("");
    console.log("=== DRY-RUN OK — 未落盘。加 --apply 才真正移动。 ===");
    return;
  }

  // 备份
  const backup = backupDir();
  fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(oldLog, path.join(backup, "session.jsonl.zstd"));
  fs.copyFileSync(WORKSPACE_PATH, path.join(backup, "workspace.json"));
  fs.copyFileSync(PROJCACHE_PATH, path.join(backup, "session_projcache.json"));
  console.log(`[apply] 备份写入 ${backup}`);

  // 移动日志
  fs.mkdirSync(path.dirname(newLog), { recursive: true });
  fs.writeFileSync(newLog, newBuf);
  fs.rmSync(oldLog);
  fs.rmSync(path.dirname(oldLog), { recursive: true, force: true });

  // 更新两个 JSON
  const wsTmp = WORKSPACE_PATH + ".move.tmp";
  fs.writeFileSync(wsTmp, JSON.stringify(wsNext, null, 2) + "\n");
  fs.renameSync(wsTmp, WORKSPACE_PATH);
  const pcTmp = PROJCACHE_PATH + ".move.tmp";
  fs.writeFileSync(pcTmp, JSON.stringify(pcNext, null, 2) + "\n");
  fs.renameSync(pcTmp, PROJCACHE_PATH);

  console.log("[apply] DONE。重启 dsh web 后侧边栏生效。");
  console.log("[apply] 备份在：" + backup);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
