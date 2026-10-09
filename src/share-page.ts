import type { ShareMeta } from "./types";

/** 分享页 / 错误页: 纯内联样式, 不依赖 CDN, 公开链接秒开 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${units[u]}`;
}

function fileIcon(mime: string): string {
  if (mime.startsWith("video/")) return "🎬";
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📄";
  if (mime.startsWith("text/")) return "📝";
  return "📦";
}

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;
color:#e8ecf4;background:#070b14;
background-image:radial-gradient(600px 400px at 15% 10%,rgba(99,102,241,.14),transparent 60%),
radial-gradient(700px 500px at 85% 90%,rgba(168,85,247,.12),transparent 60%),
radial-gradient(500px 400px at 80% 15%,rgba(34,211,238,.08),transparent 60%)}
.card{width:100%;max-width:520px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.09);
border-radius:24px;padding:40px 36px;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);
box-shadow:0 24px 80px rgba(0,0,0,.45);text-align:center;animation:up .5s ease}
@keyframes up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:28px;color:#9aa3b8;font-size:14px;letter-spacing:.2em}
.brand .logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#6d7cff,#a855f7);
display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 6px 20px rgba(109,124,255,.4)}
.icon{font-size:56px;margin-bottom:16px;filter:drop-shadow(0 8px 20px rgba(0,0,0,.4))}
.name{font-size:19px;font-weight:600;word-break:break-all;line-height:1.5;margin-bottom:10px}
.meta{color:#8b93a7;font-size:13.5px;margin-bottom:24px;display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
.preview{margin:0 auto 24px;border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,.1);max-height:300px;background:#000}
.preview img,.preview video{width:100%;max-height:300px;object-fit:contain;display:block}
.preview audio{width:100%}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:15px;border:none;border-radius:14px;
font-size:16px;font-weight:600;color:#fff;cursor:pointer;text-decoration:none;
background:linear-gradient(135deg,#6d7cff,#a855f7);box-shadow:0 10px 30px rgba(109,124,255,.35);transition:.2s}
.btn:hover{transform:translateY(-2px);box-shadow:0 14px 36px rgba(109,124,255,.5)}
.btn:active{transform:none}
.hint{margin-top:18px;color:#6b7288;font-size:12.5px}
.err-code{font-size:64px;margin-bottom:12px}
input[type=password]{width:100%;padding:14px 16px;margin-bottom:14px;border-radius:12px;border:1px solid rgba(255,255,255,.12);
background:rgba(0,0,0,.3);color:#fff;font-size:15px;outline:none;transition:.2s}
input[type=password]:focus{border-color:#6d7cff;box-shadow:0 0 0 3px rgba(109,124,255,.2)}
.err-msg{color:#f87171;font-size:13px;margin-bottom:12px;min-height:18px}
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · CunDrop</title><style>${CSS}</style></head>
<body><div class="card">
<div class="brand"><span class="logo">☁️</span>CunDrop</div>
${body}
<div class="hint">由 R2 Pan 强力驱动 · 私人分享</div>
</div></body></html>`;
}

export function renderShareError(code: number, title: string, desc: string): Response {
  const html = shell(title, `<div class="err-code">${code === 404 ? "🔍" : code === 410 ? "⌛" : "🔒"}</div>
<div class="name">${esc(title)}</div><div class="meta"><span>${esc(desc)}</span></div>`);
  return new Response(html, { status: code, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function renderPasswordPage(shareId: string, wrong: boolean): Response {
  const html = shell(
    "输入提取密码",
    `<div class="icon">🔒</div>
<div class="name">该分享设有提取密码</div>
<div class="meta"><span>请输入密码后继续</span></div>
<div class="err-msg">${wrong ? "密码不正确, 请重试" : ""}</div>
<form method="post" action="/s/${esc(shareId)}/verify">
<input type="password" name="password" placeholder="提取密码" autocomplete="off" autofocus required>
<button class="btn" type="submit">确 认</button>
</form>`
  );
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function renderSharePage(share: ShareMeta, shareId: string): string {
  const fileUrl = `/s/${encodeURIComponent(shareId)}/file`;
  let preview = "";
  if (share.mime.startsWith("video/")) {
    preview = `<div class="preview"><video controls preload="metadata" src="${fileUrl}"></video></div>`;
  } else if (share.mime.startsWith("image/")) {
    preview = `<div class="preview"><img src="${fileUrl}" alt=""></div>`;
  } else if (share.mime.startsWith("audio/")) {
    preview = `<div class="preview"><audio controls preload="metadata" src="${fileUrl}"></audio></div>`;
  }

  const expireText = share.expiresAt
    ? `有效期至 ${new Date(share.expiresAt).toLocaleString("zh-CN", { hour12: false })}`
    : "永久有效";

  return shell(
    share.name,
    `${preview}
<div class="icon">${fileIcon(share.mime)}</div>
<div class="name">${esc(share.name)}</div>
<div class="meta"><span>${formatBytes(share.size)}</span><span>${expireText}</span><span>已下载 ${share.downloads} 次</span></div>
<a class="btn" href="${fileUrl}" download="${esc(share.name)}">⬇ 下载文件</a>`
  );
}
