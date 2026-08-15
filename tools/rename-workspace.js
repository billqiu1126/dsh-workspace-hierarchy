// rename-workspace.js — 重命名工作区目录，并迁移其下所有会话与子工作区。
//
// 用法（按工作区 id 定位）：
//   node rename-workspace.js --id "<workspace-id>" "<新名称>" [--apply]
//
// 默认只做 dry-run（打印计划、校验一切、不落盘）；加 --apply 才真正执行。
// 迁移内容：
//   1. fs.rename 把工作区目录从旧路径改为「父目录/新名称」；
//   2. 重写每个受影响会话日志头 cwd（只动第一个 zstd 帧）并移动日志文件；
//   3. 更新 workspace.json 中该工作区（及所有子工作区）的 path 与 title；
//   4. 更新 session_projcache.json 中每个受影响会话的 identity.cwd。
//
// 注意：请通过 dsh 内的「重命名工作区」触发（宿主会先拦截该目录下仍打开的
// 会话）；单独运行本脚本前请先关闭 dsh，否则正在写入的会话日志可能损坏。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

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

function isWithin(p, base) {
  const n = normPath(p);
  const b = normPath(base);
  return n === b || n.startsWith(b.endsWith("/") ? b : b + "/");
}

/** 把 base 之下的路径 p 重定向到 newBase 之下（保留后缀）。 */
function rebasePath(p, oldBase, newBase) {
  if (!isWithin(p, oldBase)) throw new Error(`路径 "${p}" 不在工作区 "${oldBase}" 之下`);
  const suffix = p.slice(oldBase.length);
  return newBase + suffix;
}

function fail(msg) {
  console.error("ERROR: " + msg);
  process.exit(1);
}

function usage() {
  console.error('用法: node rename-workspace.js --id "<workspace-id>" "<新名称>" [--apply]');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, value) {
  const tmp = p + ".rename.tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function backupDir() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(BACKUP_ROOT, "backup-" + ts);
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

// ---------------- 主流程 ----------------
async function main() {
  if (argv[0] !== "--id" || argv[1] === undefined || argv[2] === undefined) {
    usage();
    process.exit(1);
  }
  const workspaceId = argv[1];
  const newTitle = argv[2];

  if (newTitle.length === 0) fail("新名称不能为空");
  if (/[/\\]/.test(newTitle)) fail("新名称不能包含路径分隔符");
  if (newTitle === "." || newTitle === "..") fail("新名称不能是 . 或 ..");

  const ws = readJson(WORKSPACE_PATH);
  const records = ws.tables.workspaces;
  const rec = records[workspaceId];
  if (!rec) fail(`workspace.json 中没有工作区 ${workspaceId}`);
  const oldPath = rec.path;
  if (path.dirname(oldPath) === oldPath) fail(`不能重命名文件系统根目录 "${oldPath}"`);
  const newPath = path.resolve(path.join(path.dirname(oldPath), newTitle));
  if (normPath(oldPath) === normPath(newPath)) fail("新名称与原文件夹名相同");
  if (fs.existsSync(newPath)) fail(`目标路径已存在：${newPath}`);

  // 受影响的工作区（path 在 oldPath 之下，含自身）
  const affectedWorkspaces = Object.entries(records)
    .filter(([, r]) => isWithin(r.path, oldPath))
    .map(([id]) => id);

  // 受影响的会话（projcache 中 cwd 在 oldPath 之下）
  const pc = readJson(PROJCACHE_PATH);
  const sessions = Object.entries(pc.tables.sessions)
    .map(([id, s]) => ({ id, cwd: s.identity.cwd }))
    .filter((s) => s.cwd && isWithin(s.cwd, oldPath));

  console.log("工作区:", workspaceId);
  console.log("旧路径:", oldPath);
  console.log("新路径:", newPath);
  console.log("模式  :", APPLY ? "APPLY" : "dry-run");
  console.log("");

  // 计划每个会话的日志迁移。日志缺失的会话跳过日志迁移（它们本就不完整），
  // 但仍会在后面更新 projcache 的 cwd，避免残留旧路径。
  const moves = [];
  const skipped = [];
  for (const s of sessions) {
    const newCwd = rebasePath(s.cwd, oldPath, newPath);
    const oldLog = logPath(s.cwd, s.id);
    const newLog = logPath(newCwd, s.id);
    if (!fs.existsSync(oldLog)) {
      skipped.push({ id: s.id, cwd: s.cwd });
      continue;
    }
    if (fs.existsSync(newLog)) fail(`目标位置已有会话日志：${newLog}`);
    moves.push({ id: s.id, oldCwd: s.cwd, newCwd, oldLog, newLog });
  }
  for (const s of skipped) {
    console.log(`[skip] 会话 ${s.id} 的日志缺失，跳过日志迁移（cwd=${s.cwd}）`);
  }
  for (const m of moves) {
    console.log(`  ${m.id}`);
    console.log(`    ${m.oldCwd}`);
    console.log(` -> ${m.newCwd}`);
  }
  for (const id of affectedWorkspaces) {
    console.log(`[workspace] ${id} ${records[id].path} -> ${rebasePath(records[id].path, oldPath, newPath)}`);
  }

  // 重写并校验每个日志头
  const rewritten = [];
  for (const m of moves) {
    const buf = rewriteHeaderCwd(m.oldLog, m.id, m.newCwd);
    const check = scanZstdFrames(buf);
    if (check.tornStart !== undefined) fail("重写后的日志有残缺帧");
    const rebuiltHeader = JSON.parse(zlib.zstdDecompressSync(buf.subarray(0, check.frames[0].end)).toString("utf8").trimEnd());
    if (rebuiltHeader.cwd !== m.newCwd) fail("重写后头部 cwd 不正确");
    rewritten.push({ ...m, buf });
  }

  if (!APPLY) {
    console.log("");
    console.log("=== DRY-RUN OK — 未落盘。加 --apply 才真正执行。 ===");
    return;
  }

  // 备份
  const backup = backupDir();
  fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(WORKSPACE_PATH, path.join(backup, "workspace.json"));
  fs.copyFileSync(PROJCACHE_PATH, path.join(backup, "session_projcache.json"));
  for (const m of rewritten) {
    const dst = path.join(backup, "logs", m.id, "session.jsonl.zstd");
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(m.oldLog, dst);
  }
  console.log(`[apply] 备份写入 ${backup}`);

  // 1. 重命名目录
  fs.renameSync(oldPath, newPath);
  console.log(`[apply] 目录已重命名：${oldPath} -> ${newPath}`);

  // 2. 迁移会话日志
  for (const m of rewritten) {
    fs.mkdirSync(path.dirname(m.newLog), { recursive: true });
    fs.writeFileSync(m.newLog, m.buf);
    fs.rmSync(m.oldLog);
    fs.rmSync(path.dirname(m.oldLog), { recursive: true, force: true });
  }
  console.log(`[apply] 已迁移 ${rewritten.length} 个会话日志`);

  // 3. 更新 workspace.json
  const wsNext = readJson(WORKSPACE_PATH);
  for (const id of affectedWorkspaces) {
    wsNext.tables.workspaces[id].path = rebasePath(wsNext.tables.workspaces[id].path, oldPath, newPath);
    wsNext.tables.workspaces[id].updatedAt = new Date().toISOString();
  }
  wsNext.tables.workspaces[workspaceId].title = newTitle;
  writeJson(WORKSPACE_PATH, wsNext);
  console.log("[apply] workspace.json 已更新");

  // 4. 更新 projcache（含日志缺失、被跳过的会话）
  const pcNext = readJson(PROJCACHE_PATH);
  for (const s of sessions) {
    const entry = pcNext.tables.sessions[s.id];
    if (entry !== undefined) entry.identity.cwd = rebasePath(entry.identity.cwd, oldPath, newPath);
  }
  writeJson(PROJCACHE_PATH, pcNext);
  console.log("[apply] session_projcache.json 已更新");

  console.log("[apply] DONE。重启 dsh web 后侧边栏生效。");
  console.log("[apply] 备份在：" + backup);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
