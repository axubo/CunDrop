import type { ApiFile, ApiShare, Env, FileMeta, ShareMeta } from "./types";
import {
  clearSessionCookie,
  createSession,
  createShareToken,
  hashSharePassword,
  sessionCookie,
  shareCookie,
  verifySession,
  verifyShareToken,
} from "./auth";
import { presignedPutUrl } from "./sign";
import { formatBytes, renderPasswordPage, renderShareError, renderSharePage } from "./share-page";

/** 单文件上传上限 5GB(S3 单 PUT 限制) */
const MAX_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024;
/** 预签名 URL 有效期 1 小时 */
const UPLOAD_URL_TTL = 3600;

function nanoid(size = 16): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let s = "";
  for (let i = 0; i < size; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function safeExt(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  const ext = name.slice(i).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

// ---------------- 文件直传(Range 支持, 供 /f/:key 与 /s/:id/file 共用) ----------------

async function serveR2Object(
  env: Env,
  key: string,
  meta: { name: string; mime: string },
  req: Request
): Promise<Response> {
  const rangeHeader = req.headers.get("range");
  const isHead = req.method === "HEAD";

  if (rangeHeader) {
    const head = await env.BUCKET.head(key);
    if (!head) return new Response("Not Found", { status: 404 });
    const size = head.size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      let start: number | null = m[1] === "" ? null : parseInt(m[1], 10);
      let end: number | null = m[2] === "" ? null : parseInt(m[2], 10);
      if (start === null && end !== null) {
        start = Math.max(0, size - end);
        end = size - 1;
      } else if (start !== null && end === null) {
        end = size - 1;
      }
      if (start !== null && end !== null && start <= end && start < size && end < size) {
        const obj = await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
        if (obj) {
          const headers = new Headers();
          headers.set("content-type", meta.mime);
          headers.set("content-range", `bytes ${start}-${end}/${size}`);
          headers.set("content-length", String(end - start + 1));
          headers.set("accept-ranges", "bytes");
          headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
          headers.set("cache-control", "private, max-age=0");
          return new Response(isHead ? null : obj.body, { status: 206, headers });
        }
      }
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }
    // Range 头格式非法
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "content-range": `bytes */${size}` },
    });
  }

  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not Found", { status: 404 });
  const headers = new Headers();
  headers.set("content-type", meta.mime);
  headers.set("content-length", String(obj.size));
  headers.set("accept-ranges", "bytes");
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  headers.set("cache-control", "private, max-age=0");
  return new Response(isHead ? null : obj.body, { headers });
}

// ---------------- KV 索引 ----------------

async function listAllFiles(env: Env): Promise<ApiFile[]> {
  const out: ApiFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: "file:", cursor });
    for (const k of page.keys) {
      const meta = await env.KV.get<FileMeta>(k.name, "json");
      if (meta) out.push({ key: k.name.slice(5), ...meta });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return out;
}

async function listAllShares(env: Env, origin: string): Promise<ApiShare[]> {
  const out: ApiShare[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: "share:", cursor });
    for (const k of page.keys) {
      const meta = await env.KV.get<ShareMeta>(k.name, "json");
      if (meta) {
        const id = k.name.slice(6);
        out.push({
          id,
          fileKey: meta.fileKey,
          name: meta.name,
          size: meta.size,
          mime: meta.mime,
          hasPassword: !!meta.passwordHash,
          expiresAt: meta.expiresAt,
          createdAt: meta.createdAt,
          downloads: meta.downloads,
          url: `${origin}/s/${id}`,
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

// ---------------- 路由 ----------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      // ===== 登录 / 会话 =====
      if (path === "/api/login" && method === "POST") {
        if (!env.ADMIN_PASSWORD) {
          return json({ error: "管理员密码未配置：请去 Cloudflare → Variables and Secrets 添加 ADMIN_PASSWORD（机密类型）" }, 500);
        }
        const body = await readJson<{ password?: string }>(req);
        if (body?.password && body.password === env.ADMIN_PASSWORD) {
          const token = await createSession(env);
          return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, 7 * 86400) });
        }
        return json({ error: "密码不正确" }, 401);
      }

      if (path === "/api/logout" && method === "POST") {
        return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
      }

      if (path === "/api/me" && method === "GET") {
        // 已移除密码登录：直接视为已登录
        return json({ authenticated: true, maxUploadSize: MAX_UPLOAD_SIZE });
      }

      // ===== 以下 API 需要登录（已移除密码，直接放行）=====

      // ===== 上传: 申请预签名 URL(浏览器直传 R2) =====
      if (path === "/api/upload/init" && method === "POST") {
        const body = await readJson<{ name?: string; size?: number }>(req);
        const name = (body?.name || "").trim().slice(0, 255);
        const size = body?.size || 0;
        if (!name) return json({ error: "文件名不能为空" }, 400);
        if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_SIZE) {
          return json({ error: `文件大小需在 1B ~ ${formatBytes(MAX_UPLOAD_SIZE)} 之间` }, 400);
        }
        const key = nanoid(16) + safeExt(name);
        const uploadUrl = await presignedPutUrl({
          accountId: env.R2_ACCOUNT_ID,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          bucket: env.BUCKET_NAME,
          key,
          expiresIn: UPLOAD_URL_TTL,
        });
        return json({ key, url: uploadUrl, expiresIn: UPLOAD_URL_TTL });
      }

      // ===== 上传: 直传完成后登记 =====
      if (path === "/api/upload/complete" && method === "POST") {
        const body = await readJson<{ key?: string; name?: string; mime?: string }>(req);
        const key = body?.key || "";
        if (!/^[0-9A-Za-z]{16}(\.[a-z0-9]{1,8})?$/.test(key)) {
          return json({ error: "非法的文件 key" }, 400);
        }
        const obj = await env.BUCKET.head(key);
        if (!obj) return json({ error: "R2 中找不到该文件, 请重新上传" }, 400);
        const name = (body?.name || "").trim().slice(0, 255) || key;
        const mime = (body?.mime || "application/octet-stream").slice(0, 128);
        const meta: FileMeta = { name, size: obj.size, mime, uploadedAt: Date.now() };
        await env.KV.put(`file:${key}`, JSON.stringify(meta));
        const file: ApiFile = { key, ...meta };
        return json({ file });
      }

      // ===== 文件列表 =====
      if (path === "/api/files" && method === "GET") {
        const all = await listAllFiles(env);
        const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "60", 10) || 60, 1), 200);
        const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
        const totalBytes = all.reduce((s, f) => s + f.size, 0);
        return json({
          files: all.slice(offset, offset + limit),
          total: all.length,
          totalBytes,
          hasMore: offset + limit < all.length,
        });
      }

      // ===== 删除文件 =====
      {
        const m = /^\/api\/files\/([0-9A-Za-z]{16}(?:\.[a-z0-9]{1,8})?)$/.exec(path);
        if (m && method === "DELETE") {
          const key = m[1];
          await env.BUCKET.delete(key);
          await env.KV.delete(`file:${key}`);
          // 级联删除指向该文件的分享
          const shares = await listAllShares(env, url.origin);
          for (const s of shares) {
            if (s.fileKey === key) await env.KV.delete(`share:${s.id}`);
          }
          return json({ ok: true });
        }
      }

      // ===== 创建分享 =====
      if (path === "/api/share" && method === "POST") {
        const body = await readJson<{ key?: string; expiresInSec?: number; password?: string }>(req);
        const key = body?.key || "";
        const fileMeta = await env.KV.get<FileMeta>(`file:${key}`, "json");
        if (!fileMeta) return json({ error: "文件不存在" }, 404);
        const expiresInSec = Math.floor(body?.expiresInSec || 0);
        const password = (body?.password || "").trim();
        const id = nanoid(10);
        const share: ShareMeta = {
          fileKey: key,
          name: fileMeta.name,
          size: fileMeta.size,
          mime: fileMeta.mime,
          passwordHash: password ? await hashSharePassword(env, password) : null,
          expiresAt: expiresInSec > 0 ? Date.now() + expiresInSec * 1000 : null,
          createdAt: Date.now(),
          downloads: 0,
        };
        await env.KV.put(`share:${id}`, JSON.stringify(share));
        return json({ id, url: `${url.origin}/s/${id}` });
      }

      // ===== 分享列表 =====
      if (path === "/api/shares" && method === "GET") {
        return json({ shares: await listAllShares(env, url.origin) });
      }

      // ===== 删除分享 =====
      {
        const m = /^\/api\/shares\/([0-9A-Za-z]{10})$/.exec(path);
        if (m && method === "DELETE") {
          await env.KV.delete(`share:${m[1]}`);
          return json({ ok: true });
        }
      }

      // ===== 管理员下载 / 预览(支持断点续传) =====
      {
        const m = /^\/f\/([0-9A-Za-z]{16}(?:\.[a-z0-9]{1,8})?)$/.exec(path);
        if (m && (method === "GET" || method === "HEAD")) {
          const meta = await env.KV.get<FileMeta>(`file:${m[1]}`, "json");
          if (!meta) return new Response("Not Found", { status: 404 });
          return serveR2Object(env, m[1], meta, req);
        }
      }

      // ===== 公开分享页 =====
      {
        const m = /^\/s\/([0-9A-Za-z]{10})$/.exec(path);
        if (m && method === "GET") {
          const share = await env.KV.get<ShareMeta>(`share:${m[1]}`, "json");
          if (!share) return renderShareError(404, "分享不存在", "该链接无效或已被撤销");
          if (share.expiresAt && share.expiresAt < Date.now()) {
            return renderShareError(410, "分享已过期", "该链接已超过有效期");
          }
          if (share.passwordHash && !(await verifyShareToken(env, m[1], req.headers.get("cookie")))) {
            return renderPasswordPage(m[1], url.searchParams.get("err") === "1");
          }
          // 文件若已被删除, 分享即失效
          const exists = await env.BUCKET.head(share.fileKey);
          if (!exists) return renderShareError(410, "文件已被删除", "分享的文件不存在了");
          return new Response(renderSharePage(share, m[1]), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
      }

      // ===== 分享密码校验 =====
      {
        const m = /^\/s\/([0-9A-Za-z]{10})\/verify$/.exec(path);
        if (m && method === "POST") {
          const share = await env.KV.get<ShareMeta>(`share:${m[1]}`, "json");
          if (!share || !share.passwordHash) {
            return Response.redirect(`${url.origin}/s/${m[1]}`, 302);
          }
          const form = await req.formData().catch(() => null);
          const password = (form?.get("password") || "").toString();
          const ok = (await hashSharePassword(env, password)) === share.passwordHash;
          if (!ok) return Response.redirect(`${url.origin}/s/${m[1]}?err=1`, 302);
          const token = await createShareToken(env, m[1]);
          return new Response(null, {
            status: 302,
            headers: {
              location: `${url.origin}/s/${m[1]}`,
              "set-cookie": shareCookie(m[1], token),
            },
          });
        }
      }

      // ===== 分享文件下载(计数+断点续传) =====
      {
        const m = /^\/s\/([0-9A-Za-z]{10})\/file$/.exec(path);
        if (m && (method === "GET" || method === "HEAD")) {
          const share = await env.KV.get<ShareMeta>(`share:${m[1]}`, "json");
          if (!share) return new Response("Not Found", { status: 404 });
          if (share.expiresAt && share.expiresAt < Date.now()) {
            return new Response("Gone", { status: 410 });
          }
          if (share.passwordHash && !(await verifyShareToken(env, m[1], req.headers.get("cookie")))) {
            return Response.redirect(`${url.origin}/s/${m[1]}`, 302);
          }
          const exists = await env.BUCKET.head(share.fileKey);
          if (!exists) return new Response("Gone", { status: 410 });
          if (method === "GET" && !req.headers.get("range")) {
            // 完整下载才计数, 断点续传的分片请求不重复计
            share.downloads += 1;
            await env.KV.put(`share:${m[1]}`, JSON.stringify(share));
          }
          return serveR2Object(env, share.fileKey, share, req);
        }
      }

      return json({ error: "Not Found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "服务器内部错误" }, 500);
    }
  },
};
