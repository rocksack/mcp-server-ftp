import * as crypto from "crypto";
import * as fs from "fs";
import { execFile } from "child_process";
import { pathToFileURL } from "url";

// FTP-Passwoerter stehen verschluesselt (AES-256-GCM) in der Seitenliste ftp-sites.json, Feld "pw":
//   v1:<iv>:<tag>:<ciphertext>   (je base64)
// Der gemeinsame Schluessel (32 Byte, base64) liegt im Tresor als "MCP FTP Schluessel" und auf jedem
// Laptop in der Windows-Anmeldeinformationsverwaltung (Ziel "claude-ftp-key"), nie in Dateien.
// Dieses Modul ist die einzige Stelle fuer Ver-/Entschluesseln: Server (multi.js) und PowerShell-Skripte
// (ueber die Befehlszeile unten) nutzen dasselbe Verfahren.
const KEY_CRED = process.env.FTP_KEY_CRED_TARGET || "claude-ftp-key";

const READ_CRED_PS = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class CredRd {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CRED { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int BlobSize; public IntPtr Blob; public int Persist; public int AttrCount; public IntPtr Attrs; public string Alias; public string User; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string t, int type, int f, out IntPtr p);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static string Read(string t) {
    IntPtr p; if (!CredRead(t, 1, 0, out p)) return null;
    try { CRED c = (CRED)Marshal.PtrToStructure(p, typeof(CRED)); return Marshal.PtrToStringUni(c.Blob, c.BlobSize/2); } finally { CredFree(p); }
  }
}
'@
$v=[CredRd]::Read($env:FTP_CRED_TARGET); if($null -eq $v){ exit 3 }; [Console]::Out.Write($v)`;

let keyCache: Buffer | null = null;

function readCred(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", READ_CRED_PS],
      { env: { ...process.env, FTP_CRED_TARGET: KEY_CRED }, timeout: 20000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout.toString().trim())));
  });
}

export async function getKey(): Promise<Buffer> {
  if (keyCache) return keyCache;
  let b64 = process.env.FTP_KEY_B64 || "";   // Notweg/Test: Schluessel direkt aus der Umgebung
  if (!b64) {
    try { b64 = await readCred(); } catch {
      throw new Error(`FTP-Schluessel fehlt: in der Windows-Anmeldeinformationsverwaltung gibt es keinen Eintrag '${KEY_CRED}'. Einmal Icon -> Option 3 ausfuehren.`);
    }
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("FTP-Schluessel hat nicht 32 Byte");
  keyCache = key;
  return key;
}

export function genKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

export function encrypt(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(token: string, key: Buffer): string {
  const p = token.split(":");
  if (p.length !== 4 || p[0] !== "v1") throw new Error("Passwortfeld hat ein unbekanntes Format");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(p[1], "base64"));
  d.setAuthTag(Buffer.from(p[2], "base64"));
  return Buffer.concat([d.update(Buffer.from(p[3], "base64")), d.final()]).toString("utf8");
}

export async function getFtpLogin(slug: string, site: { user: string; pw?: string }): Promise<{ user: string; password: string }> {
  // Ausnahme/Notweg: FTP_PASSWORD_<KUERZEL> in der Umgebung (z. B. fuer Tests) hat Vorrang
  const envName = "FTP_PASSWORD_" + slug.toUpperCase().replace(/-/g, "_");
  if (process.env[envName]) return { user: site.user, password: process.env[envName] as string };
  if (!site.pw) throw new Error(`Kein Passwort fuer '${slug}' in der Seitenliste. Icon -> Option 3 ausfuehren.`);
  try {
    return { user: site.user, password: decrypt(site.pw, await getKey()) };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("FTP-Schluessel")) throw e;
    throw new Error(`Passwort fuer '${slug}' nicht entschluesselbar (falscher Schluessel?). Icon -> Option 3 ausfuehren.`);
  }
}

// ---- Befehlszeile fuer die PowerShell-Skripte (Klartext nur ueber Standardeingabe/-ausgabe) ----
//   genkey                        neuer Schluessel (base64) auf stdout
//   encrypt                       stdin Klartext -> stdout Token
//   decrypt                       stdin Token    -> stdout Klartext
//   sync-passwords <sitesfile>    stdin JSON {kuerzel: passwort}; schreibt "pw" in die Liste, wo es fehlt oder abweicht
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    process.stdin.on("data", (d) => parts.push(Buffer.from(d)));
    process.stdin.on("end", () => resolve(Buffer.concat(parts).toString("utf8").replace(/^﻿/, "")));
  });
}

async function cli(cmd: string, arg?: string) {
  if (cmd === "genkey") { process.stdout.write(genKey()); return; }
  const key = await getKey();
  if (cmd === "encrypt") { process.stdout.write(encrypt((await readStdin()).replace(/[\r\n]+$/, ""), key)); return; }
  if (cmd === "decrypt") { process.stdout.write(decrypt((await readStdin()).trim(), key)); return; }
  if (cmd === "sync-passwords") {
    if (!arg) throw new Error("Pfad der Seitenliste fehlt");
    const text = fs.readFileSync(arg, "utf8").replace(/^﻿/, "");
    const list = JSON.parse(text);
    const pws = JSON.parse(await readStdin()) as Record<string, string>;
    let changed = 0, same = 0; const skipped: string[] = [];
    for (const [slug, plain] of Object.entries(pws)) {
      const s = list.sites?.[slug];
      if (!s || s.blocked || !plain) { skipped.push(slug); continue; }
      let current = "";
      try { current = s.pw ? decrypt(s.pw, key) : ""; } catch { /* anderer Schluessel: neu schreiben */ }
      if (current === plain) { same++; continue; }
      s.pw = encrypt(plain, key); changed++;
    }
    if (changed > 0) {
      fs.copyFileSync(arg, arg + ".bak");
      const tmp = arg + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
      fs.renameSync(tmp, arg);
    }
    process.stdout.write(JSON.stringify({ changed, same, skipped }));
    return;
  }
  throw new Error(`Unbekannter Befehl '${cmd}'`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv[2] || "", process.argv[3]).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
