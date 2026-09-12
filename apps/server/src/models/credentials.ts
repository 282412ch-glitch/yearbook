import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CredentialMode, CredentialStatus } from '@yearbook/shared';
import { AppError } from '../errors.js';

export const credentialReferencePattern = /^yearbook:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface CredentialDriver { read(ref: string): Promise<string | null>; write(ref: string, secret: string): Promise<void>; remove(ref: string): Promise<void>; }

// This static program contains no credentials. Request data travels over the child's stdin.
const credentialProgram = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YearbookCredentials {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist;
    public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Write(ref Credential credential, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Delete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll")] public static extern void CredFree(IntPtr pointer);
}
'@
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.reference -notmatch '^yearbook:[a-f0-9-]{36}$') { throw 'Invalid reference' }
  $target = 'Yearbook/' + $request.reference
  if ($request.action -eq 'read') {
    $pointer = [IntPtr]::Zero
    if (-not [YearbookCredentials]::Read($target, 1, 0, [ref]$pointer)) {
      if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { '{"ok":true,"value":null}'; exit 0 }
      throw 'Credential read failed'
    }
    try {
      $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [Type][YearbookCredentials+Credential])
      $bytes = New-Object byte[] $credential.CredentialBlobSize
      [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
      @{ ok=$true; value=[Convert]::ToBase64String($bytes) } | ConvertTo-Json -Compress
      [Array]::Clear($bytes, 0, $bytes.Length)
    } finally { [YearbookCredentials]::CredFree($pointer) }
  } elseif ($request.action -eq 'write') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($request.secret)
    $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    try {
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
      $credential = New-Object YearbookCredentials+Credential
      $credential.Type = 1; $credential.TargetName = $target; $credential.Persist = 2
      $credential.CredentialBlobSize = $bytes.Length; $credential.CredentialBlob = $pointer
      $credential.UserName = 'Yearbook'
      if (-not [YearbookCredentials]::Write([ref]$credential, 0)) { throw 'Credential write failed' }
      '{"ok":true}'
    } finally {
      for ($index=0; $index -lt $bytes.Length; $index++) { [Runtime.InteropServices.Marshal]::WriteByte($pointer,$index,0) }
      [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
  } elseif ($request.action -eq 'remove') {
    if (-not [YearbookCredentials]::Delete($target, 1, 0) -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'Credential delete failed' }
    '{"ok":true}'
  } else { throw 'Invalid action' }
} catch { '{"ok":false}'; exit 1 }
`;

function credentialUnavailable() { return new AppError(503, 'CREDENTIALS_UNAVAILABLE', 'Windows 系统凭据当前不可用。可以在设置中明确选择“仅本次会话”，密钥将只保留到服务关闭'); }
function validateReference(reference: string) { if (!credentialReferencePattern.test(reference)) throw new AppError(400, 'INVALID_CREDENTIAL_REFERENCE', '本应用凭据引用无效，请重新配置密钥'); }

export class WindowsCredentialDriver implements CredentialDriver {
  private async invoke(action: 'read' | 'write' | 'remove', reference: string, secret?: string): Promise<string | null> {
    validateReference(reference);
    if (process.platform !== 'win32') throw credentialUnavailable();
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(credentialProgram, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let done = false;
      const finish = (error?: Error, value: string | null = null) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(credentialUnavailable()); }, 12000);
      child.on('error', () => finish(credentialUnavailable()));
      child.stdin.on('error', () => finish(credentialUnavailable()));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 16000) { child.kill(); finish(credentialUnavailable()); } });
      child.stderr.resume(); // Never propagate diagnostics which might include request data.
      child.on('close', code => {
        try {
          const result = JSON.parse(output.replace(/^\uFEFF/, '').trim()) as { ok: boolean; value?: string | null };
          if (code !== 0 || !result.ok) throw new Error();
          finish(undefined, typeof result.value === 'string' ? Buffer.from(result.value, 'base64').toString('utf8') : null);
        } catch { finish(credentialUnavailable()); }
      });
      child.stdin.end(JSON.stringify({ action, reference, secret }), 'utf8');
    });
  }
  read(ref: string) { return this.invoke('read', ref); }
  async write(ref: string, secret: string) { await this.invoke('write', ref, secret); }
  async remove(ref: string) { await this.invoke('remove', ref); }
}

export class CredentialVault {
  private session = new Map<string, string>();
  private statusPromise?: Promise<CredentialStatus>;
  constructor(private driver: CredentialDriver = new WindowsCredentialDriver()) {}
  status(): Promise<CredentialStatus> {
    return this.statusPromise ??= this.driver.read(`yearbook:${randomUUID()}`).then(() => ({ windowsAvailable: true, defaultMode: 'windows' as const, message: '密钥可保存到当前 Windows 用户的系统凭据中；数据库只保存引用。' })).catch(() => ({ windowsAvailable: false, defaultMode: 'session' as const, message: '系统凭据不可用。可选择仅本次会话；关闭本地服务后需要重新填写密钥。无 Key 的本地服务可选“不使用密钥”。' }));
  }
  async read(mode: CredentialMode, ref: string | null): Promise<string | null> {
    if (!ref || mode === 'none') return null;
    validateReference(ref);
    return mode === 'session' ? this.session.get(ref) ?? null : this.driver.read(ref);
  }
  async write(mode: CredentialMode, ref: string, secret: string) {
    validateReference(ref);
    if (Buffer.byteLength(secret, 'utf8') > 2500) throw new AppError(400, 'KEY_TOO_LONG', '密钥内容过长，最多支持 2500 字节');
    if (mode === 'session') this.session.set(ref, secret);
    else if (mode === 'windows') await this.driver.write(ref, secret);
  }
  async remove(mode: CredentialMode, ref: string | null) {
    if (!ref) return;
    validateReference(ref);
    if (mode === 'session') this.session.delete(ref);
    else if (mode === 'windows') await this.driver.remove(ref);
  }
  clearSession() { this.session.clear(); }
}
