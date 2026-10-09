export interface Env {
  BUCKET: R2Bucket;
  KV: KVNamespace;
  BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
  ADMIN_PASSWORD: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  SESSION_SECRET: string;
}

export interface FileMeta {
  /** 原始文件名 */
  name: string;
  /** 字节数 */
  size: number;
  /** MIME 类型 */
  mime: string;
  /** 上传时间戳(ms) */
  uploadedAt: number;
}

export interface ShareMeta {
  /** 指向的文件 key */
  fileKey: string;
  /** 冗余的文件名(文件被删后分享即失效, 保留名字用于展示) */
  name: string;
  size: number;
  mime: string;
  /** 分享密码的 hash, null 表示无密码 */
  passwordHash: string | null;
  /** 过期时间戳(ms), null 表示永久 */
  expiresAt: number | null;
  createdAt: number;
  downloads: number;
}

export interface ApiFile extends FileMeta {
  key: string;
}

export interface ApiShare {
  id: string;
  fileKey: string;
  name: string;
  size: number;
  mime: string;
  hasPassword: boolean;
  expiresAt: number | null;
  createdAt: number;
  downloads: number;
  url: string;
}
