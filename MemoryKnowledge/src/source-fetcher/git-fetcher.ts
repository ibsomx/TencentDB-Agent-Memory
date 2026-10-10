/**
 * GitSourceFetcher — 基于 simple-git 的源码拉取实现。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全防护（002 §4-5）：
 *   - R1 git hooks：clone/fetch 本就不拉取远端 .git/hooks（hooks 为本地态），故不额外
 *     配置 core.hooksPath（加固版 git 会拒绝该配置，需 allowUnsafeHooksPath）。
 *   - R2 SSRF：只允许 public HTTPS + 内网/环回地址黑名单（对齐项目 security_rules）。
 *   - Bug 修复（方案 A）：增量 sync 的 git clean 排除 .codegraph/，避免删掉 codegraph 索引库。
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

/**
 * 识别 git 认证 / 权限类错误（simple-git 无 TTY，git 交互式询问 Username/Password
 * 会变成 `could not read Username for '...': No such device or address`）。
 *
 * 这类错误对用户极具误导性：本质是仓库需要认证（401/403），却被 git 表述成
 * 「无法读取用户名」。用这里集中识别，再在 worker 层按是否带凭据转成人类可读提示。
 */
export function isGitAuthError(raw: string): boolean {
  const msg = raw.toLowerCase();
  return (
    msg.includes("could not read username") ||
    msg.includes("could not read password") ||
    msg.includes("authentication failed") ||
    msg.includes("permission denied") ||
    msg.includes("returned error: 401") ||
    msg.includes("returned error: 403") ||
    msg.includes("could not read from remote repository") ||
    msg.includes("unable to access") ||
    msg.includes("remote: you are not allowed")
  );
}

/** 把 git 认证错误转成面向用户的提示。needsCredential = clone 时是否已注入凭据。 */
export function explainGitAuthError(raw: string, needsCredential: boolean): string {
  const brief = raw.split("\n").find((l) => l.trim())?.trim() ?? raw.trim();
  if (needsCredential) {
    return (
      `访问令牌无效或已过期，无法拉取仓库（git: ${brief}）。` +
      `请在仓库详情里重新填写访问令牌。`
    );
  }
  return (
    `该仓库需要身份认证，无法以「公开」方式克隆（git: ${brief}）。` +
    `请删除后重新注册，来源选择对应的代码平台并填写访问令牌。`
  );
}

/**
 * 内网 / 环回 / link-local 地址黑名单（标准网段）：
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 私有网段
 *   - 169.254.                     → link-local（含云元数据 169.254.169.254）
 *   - 127. / 0. / localhost / ::1  → 环回
 *   - fe80:                        → IPv6 link-local
 *
 * 该黑名单可通过环境变量 KNOWLEDGE_SSRF_CHECK=off 关闭（见 GitSourceFetcher 构造）。
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/**
 * 读取 SSRF 私网黑名单开关。默认开启；
 * 当 KNOWLEDGE_SSRF_CHECK 为 off/false/0/no（大小写不敏感）时关闭。
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

export interface GitSourceFetcherOptions {
  /**
   * 是否启用 SSRF 私网 / 环回地址黑名单校验。
   * 默认读环境变量 KNOWLEDGE_SSRF_CHECK（默认开启）；显式传入时优先于环境变量。
   */
  ssrfCheck?: boolean;
}


function quote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid credential path");
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function normalizeGitUrl(value: string): URL {
  if (!value || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid Git URL");
  const scp = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)@([A-Za-z0-9.-]+):([^?#]+)$/.exec(value);
  let url: URL;
  try { url = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : value); }
  catch { throw new Error("Invalid Git URL"); }
  if (!["https:", "ssh:"].includes(url.protocol)) throw new Error("Git URL must use HTTPS or SSH");
  if (!url.hostname || url.hostname.startsWith("-") || url.search || url.hash || url.pathname === "/") throw new Error("Repository path required; query/fragment forbidden");
  if (url.password || (url.protocol === "https:" && url.username)) throw new Error("Use environment credentials, not URL credentials");
  if (url.username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(url.username)) throw new Error("Invalid SSH username");
  try { if (/[\x00-\x1f\x7f]/.test(decodeURIComponent(url.pathname))) throw new Error(); }
  catch { throw new Error("Invalid repository path"); }
  return url;
}

function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (PRIVATE_ADDR_RE.test(h) || h === "::" || h.endsWith(".localhost") || (/^(fc|fd|fe[89ab])/.test(h) && h.includes(":"))) return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!mapped) return false;
  const n = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16);
  return privateHost([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";
  private readonly ssrfCheck: boolean;
  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
  }
  validate(sourceUrl: string): void {
    const url = normalizeGitUrl(sourceUrl);
    if (this.ssrfCheck && privateHost(url.hostname)) throw new Error("Private/loopback Git host blocked");
  }
  private branch(branch: string): void {
    if (!branch || branch.startsWith("-") || /[\s\x00-\x1f~^:?*\[]/.test(branch) || branch.includes(String.fromCharCode(92)) || branch.includes("..") || branch.includes("@{")) throw new Error("Invalid Git branch");
  }
  private async authenticated<T>(sourceUrl: string, baseDir: string | undefined, action: (git: ReturnType<typeof simpleGit>, url: string) => Promise<T>): Promise<T> {
    this.validate(sourceUrl);
    const url = normalizeGitUrl(sourceUrl);
    const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
    for (const k of Object.keys(env)) if (k.startsWith("GIT_TRACE") || k === "GIT_CURL_VERBOSE") delete env[k];
    const pat = process.env.KNOWLEDGE_GIT_PAT;
    const key = process.env.KNOWLEDGE_GIT_SSH_KEY_PATH;
    if (url.protocol === "https:" ? !!pat : !!key) {
      const hosts = (process.env.KNOWLEDGE_GIT_AUTH_HOSTS ?? "").split(",").map(h => h.trim().toLowerCase());
      if (!hosts.includes(url.host.toLowerCase())) throw new Error("Set KNOWLEDGE_GIT_AUTH_HOSTS for the credential destination");
    }
    let temp: string | undefined;
    try {
      if (url.protocol === "https:" && pat) {
        if (/[\r\n\0]/.test(pat) || /[\r\n\0]/.test(process.env.KNOWLEDGE_GIT_USERNAME ?? "")) throw new Error("Invalid credential format");
        temp = await mkdtemp(join(tmpdir(), "knowledge-git-auth-"));
        const helper = join(temp, "askpass.cjs");
        await writeFile(helper, `const p=process.argv[2]||"";\nif(/^Username/i.test(p))process.stdout.write(process.env.KNOWLEDGE_GIT_USERNAME||"oauth2");\nelse if(/^Password/i.test(p))process.stdout.write(process.env.KNOWLEDGE_GIT_PAT||"");\nelse process.exit(1);\n`, { mode: 0o600 });
        const launcher = join(temp, "askpass.sh");
        await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath.replace(/\\/g, "/"))} ${quote(helper.replace(/\\/g, "/"))} "$@"\n`, { mode: 0o700 });
        env.GIT_ASKPASS = quote(launcher.replace(/\\/g, "/"));
      } else if (url.protocol === "ssh:") {
        let ssh = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes";
        if (key) {
          if (!isAbsolute(key)) throw new Error("SSH key path must be absolute");
          ssh += ` -o IdentitiesOnly=yes -i ${quote(key.replace(/\\/g, "/"))}`;
        }
        const known = process.env.KNOWLEDGE_GIT_SSH_KNOWN_HOSTS_PATH;
        if (known) {
          if (!isAbsolute(known)) throw new Error("known_hosts path must be absolute");
          ssh += ` -o UserKnownHostsFile=${quote(known.replace(/\\/g, "/"))}`;
        }
        env.GIT_SSH_COMMAND = ssh;
        env.GIT_SSH_VARIANT = "ssh";
        delete env.GIT_ASKPASS;
        delete env.KNOWLEDGE_GIT_PAT;
      }
      const git = simpleGit({ baseDir, config: ["credential.helper=", "http.followRedirects=false", "protocol.file.allow=never", "protocol.ext.allow=never"] }).env(env);
      try { return await action(git, url.toString()); }
      catch { throw new Error("Git clone/sync failed: verify credentials, repository permissions, branch and trusted SSH host keys"); }
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true });
    }
  }
  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.branch(branch);
    return this.authenticated(sourceUrl, undefined, async (git, url) => {
      await git.clone(url, localPath, { "--depth": 1, "--branch": branch });
      return { localPath, version: await this.headCommit(localPath), sourceType: "git" };
    });
  }
  async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.branch(branch);
    return this.authenticated(sourceUrl, localPath, async (git, url) => {
      await git.remote(["set-url", "origin", url]);
      await git.fetch(url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`, { "--depth": 1 });
      await git.reset(ResetMode.HARD, [`refs/remotes/origin/${branch}`]);
      await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
      return { localPath, version: await this.headCommit(localPath), sourceType: "git" };
    });
  }
  private async headCommit(localPath: string): Promise<string | null> {
    try { return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12); }
    catch { return null; }
  }
}
