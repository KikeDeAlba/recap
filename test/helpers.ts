import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ToolCalling, ToolResponse } from '../src/bita/client.ts'
import { saveMeeting, type Meeting } from '../src/core/meeting.ts'

export function tempDir(t: { after: (fn: () => void) => void }, prefix = 'recap-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function writeBytes(file: string, bytes: number): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.alloc(bytes, 7))
}

export function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return { schemaVersion: 1, id: 'm', title: 'Daily', mode: 'remote', status: 'recording', createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), stages: {}, ...overrides }
}

export function meetingDir(t: { after: (fn: () => void) => void }, overrides: Partial<Meeting> = {}): { dir: string; meeting: Meeting } {
  const dir = tempDir(t)
  mkdirSync(path.join(dir, 'live'), { recursive: true })
  const value = meeting(overrides)
  saveMeeting(value, dir)
  return { dir, meeting: value }
}

export class FakeTool implements ToolCalling {
  calls: string[][] = []
  readonly handler: (args: string[]) => ToolResponse

  constructor(handler: (args: string[]) => ToolResponse) {
    this.handler = handler
  }

  async invoke(args: readonly string[]): Promise<ToolResponse> {
    this.calls.push([...args])
    return this.handler([...args])
  }
}

export function sandboxEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: path.join(dir, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(dir, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(dir, '.config'),
    XDG_DATA_HOME: path.join(dir, '.local', 'share'),
    XDG_STATE_HOME: path.join(dir, '.local', 'state'),
    KIT_REGISTRY_DIR: path.join(dir, 'registry'),
    KIT_CREDENTIALS: 'file',
    RECAP_ROOT: path.join(dir, 'Recap'),
    RECAP_CONFIG_PATH: path.join(dir, 'config', 'config.json'),
    RECAP_STATE_DIR: path.join(dir, 'state'),
    RECAP_DATA_DIR: path.join(dir, 'data'),
    RECAP_APP: path.join(dir, 'NoRecap.app'),
    ...extra,
  }
}

export function useSandbox(dir: string): void {
  const env = sandboxEnv(dir)
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'KIT_REGISTRY_DIR', 'RECAP_ROOT', 'RECAP_CONFIG_PATH', 'RECAP_STATE_DIR', 'RECAP_DATA_DIR', 'RECAP_APP']) {
    process.env[key] = env[key]
  }
}

const processSandbox = mkdtempSync(path.join(tmpdir(), 'recap-sandbox-'))
useSandbox(processSandbox)
process.on('exit', () => rmSync(processSandbox, { recursive: true, force: true }))
