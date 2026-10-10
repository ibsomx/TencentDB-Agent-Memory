
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
const mocks = vi.hoisted(() => ({ factory: vi.fn(), clone: vi.fn(), fetch: vi.fn(), reset: vi.fn(), clean: vi.fn(), remote: vi.fn(), env: vi.fn(), revparse: vi.fn() }));
vi.mock("simple-git", () => ({ default: mocks.factory, ResetMode: { HARD: "hard" }, CleanOptions: { FORCE: "f", RECURSIVE: "d" } }));
import { GitSourceFetcher } from "./git-fetcher.js";
let childEnv: any;
beforeEach(() => {
 vi.resetAllMocks(); vi.unstubAllEnvs(); childEnv = undefined;
 for(const k of ['KNOWLEDGE_GIT_PAT','KNOWLEDGE_GIT_SSH_KEY_PATH','KNOWLEDGE_GIT_AUTH_HOSTS','KNOWLEDGE_GIT_SSH_KNOWN_HOSTS_PATH','KNOWLEDGE_SSRF_CHECK']) vi.stubEnv(k, '');
 const git={...mocks};mocks.factory.mockReturnValue(git);mocks.env.mockImplementation(e=>{childEnv=e;return git});mocks.revparse.mockResolvedValue('123456789012abcdef');
});
afterEach(()=>vi.unstubAllEnvs());
describe('URL validation',()=>{
 it.each(['https://github.com/team/private.git','ssh://git@gitlab.com/team/repo.git','git@github.com:team/repo.git','ssh://git@gitlab.com:2222/team/repo'])('accepts %s',url=>expect(()=>new GitSourceFetcher().validate(url)).not.toThrow());
 it.each(['http://github.com/a/b','git://github.com/a/b','file:///tmp/repo','ext::bad','--upload-pack=x','https://token@github.com/a/b','ssh://git:secret@github.com/a/b','https://github.com/','https://github.com/a/b?token=x','https://github.com/a/b#x','https://github.com/a/%0a','https://127.0.0.1/a/b','https://2130706433/a/b','ssh://git@[::1]/a/b','https://[::ffff:127.0.0.1]/a/b','https://[fd00::1]/a/b','https://10.0.0.1/a/b'])('rejects %s',url=>expect(()=>new GitSourceFetcher().validate(url)).toThrow());
 it('SSRF override does not allow insecure schemes',()=>{const f=new GitSourceFetcher({ssrfCheck:false});expect(()=>f.validate('https://127.0.0.1/a/b')).not.toThrow();expect(()=>f.validate('http://127.0.0.1/a/b')).toThrow()});
});
it('clones public HTTPS with clean URL and no interactive prompt',async()=>{
 const result=await new GitSourceFetcher().fetch('https://github.com/a/b','main','target');
 expect(mocks.clone.mock.calls[0][0]).toBe('https://github.com/a/b');expect(childEnv.GIT_TERMINAL_PROMPT).toBe('0');expect(result.version).toBe('123456789012');
});
it('PAT helper uses child env, not URL/disk, and is removed after success',async()=>{
 vi.stubEnv('KNOWLEDGE_GIT_PAT','FAKE-PAT-test');vi.stubEnv('KNOWLEDGE_GIT_AUTH_HOSTS','github.com');
 let helper:string;
 mocks.clone.mockImplementation(async()=>{
 const launcher=childEnv.GIT_ASKPASS.slice(1,-1);helper=join(dirname(launcher),'askpass.cjs');
 const script=await readFile(helper,'utf8');expect(script).not.toContain('FAKE-PAT-test');
 let output='';runInNewContext(script,{process:{argv:['node','helper','Password for https://github.com'],env:childEnv,stdout:{write:(value:string)=>{output+=value}},exit:()=>{throw new Error('Unexpected exit')}}});expect(output).toBe('FAKE-PAT-test');
 expect((await readFile(launcher,'utf8')).startsWith('#!/bin/sh\n')).toBe(true);
 });
 await new GitSourceFetcher().fetch('https://github.com/a/b','main','target');
 expect(JSON.stringify(mocks.clone.mock.calls)).not.toContain('FAKE-PAT-test');await expect(access(helper!)).rejects.toThrow();
});
it('cleans helper and redacts remote errors on failure',async()=>{
 vi.stubEnv('KNOWLEDGE_GIT_PAT','FAKE-PAT-test');vi.stubEnv('KNOWLEDGE_GIT_AUTH_HOSTS','github.com');
 let helper='';mocks.clone.mockImplementation(async()=>{helper=childEnv.GIT_ASKPASS.slice(1,-1);throw new Error('leaked FAKE-PAT-test')});
 await expect(new GitSourceFetcher().fetch('https://github.com/a/b','main','target')).rejects.toThrow('Git clone/sync failed');
 await expect(access(helper)).rejects.toThrow();
});
it('rejects credentials for unapproved hosts',async()=>{vi.stubEnv('KNOWLEDGE_GIT_PAT','FAKE');vi.stubEnv('KNOWLEDGE_GIT_AUTH_HOSTS','gitlab.com');await expect(new GitSourceFetcher().fetch('https://github.com/a/b','main','target')).rejects.toThrow('AUTH_HOSTS');expect(mocks.clone).not.toHaveBeenCalled()});
it('SSH uses key, strict known hosts, no PAT, no secret argument',async()=>{
 vi.stubEnv('KNOWLEDGE_GIT_PAT','FAKE');vi.stubEnv('KNOWLEDGE_GIT_SSH_KEY_PATH','C:/keys/team key');vi.stubEnv('KNOWLEDGE_GIT_SSH_KNOWN_HOSTS_PATH','C:/keys/known_hosts');vi.stubEnv('KNOWLEDGE_GIT_AUTH_HOSTS','github.com');
 await new GitSourceFetcher().fetch('git@github.com:a/b','main','target');
 expect(childEnv.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes');expect(childEnv.GIT_SSH_COMMAND).toContain("'C:/keys/team key'");expect(childEnv.KNOWLEDGE_GIT_PAT).toBeUndefined();expect(mocks.clone.mock.calls[0][0]).toBe('ssh://git@github.com/a/b');
});
it('sync authenticates against clean source URL and preserves index',async()=>{
 await new GitSourceFetcher().sync('https://github.com/a/b','main','target');
 expect(mocks.remote).toHaveBeenCalledWith(['set-url','origin','https://github.com/a/b']);expect(mocks.fetch.mock.calls[0][0]).toBe('https://github.com/a/b');expect(mocks.clean.mock.calls[0][1]).toEqual(['-e','.codegraph']);
});
it('rejects malicious branch before launching git',async()=>{await expect(new GitSourceFetcher().fetch('https://github.com/a/b','--upload-pack=bad','target')).rejects.toThrow('Invalid Git branch');expect(mocks.clone).not.toHaveBeenCalled()});
it('does not inherit credential tracing',async()=>{vi.stubEnv('GIT_TRACE','1');vi.stubEnv('GIT_CURL_VERBOSE','1');await new GitSourceFetcher().fetch('https://github.com/a/b','main','target');expect(childEnv.GIT_TRACE).toBeUndefined();expect(childEnv.GIT_CURL_VERBOSE).toBeUndefined()});

import { stripCredentials } from "../code-source/clone-url.js";
it("worker retains SSH username",()=>expect(stripCredentials("ssh://git@github.com/a/b")).toBe("ssh://git@github.com/a/b"));
it("worker removes HTTPS credentials",()=>expect(stripCredentials("https://user:FAKE@github.com/a/b")).toBe("https://github.com/a/b"));
