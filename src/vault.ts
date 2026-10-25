import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Passwoerter holt der Server selbst aus Vaultwarden (Eintrag "MCP FTP <kuerzel>").
// Zugang: eigenes Vaultwarden-Konto nur fuer diese Eintraege. Seine Zugangsdaten liegen
// in der Windows-Anmeldeinformationsverwaltung (Ziel "claude-ftp-tresor"), nie in Dateien.
// Eigener bw-Datenordner, damit Mikes persoenliche bw-Anmeldung unberuehrt bleibt.
const CRED_TARGET = process.env.FTP_VAULT_CRED_TARGET || "claude-ftp-tresor";
const BW_SERVER = process.env.FTP_VAULT_SERVER || "https://vault.sercosys.de:7277";
const BW_DATA = process.env.FTP_VAULT_BWDIR || path.join(process.env.LOCALAPPDATA || os.tmpdir(), "claude-ftp", "bw");
const BW_JS =
  process.env.BW_JS || path.join(process.env.APPDATA || "", "npm", "node_modules", "@bitwarden", "cli", "build", "bw.js");

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

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split("\n")[0]));
      else resolve(stdout.toString());
    });
  });
}

interface VaultAccess { email: string; password: string; clientId?: string; clientSecret?: string }

let sessionPromise: Promise<string> | null = null;
const cache = new Map<string, { user: string; password: string }>();

async function readAccess(): Promise<VaultAccess> {
  let raw: string;
  try {
    raw = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", READ_CRED_PS], {
      ...process.env, FTP_CRED_TARGET: CRED_TARGET,
    }, 20000);
  } catch {
    throw new Error(
      `Tresor-Zugang fehlt: in der Windows-Anmeldeinformationsverwaltung gibt es keinen Eintrag '${CRED_TARGET}'. Einmalig Setup-FtpTresor.ps1 ausfuehren (NAS claude-sync).`
    );
  }
  const acc = JSON.parse(raw) as VaultAccess;
  if (!acc.email || !acc.password) throw new Error("Tresor-Zugang unvollstaendig (email/password)");
  return acc;
}

async function openSession(): Promise<string> {
  if (!fs.existsSync(BW_JS)) throw new Error(`Bitwarden CLI nicht gefunden: ${BW_JS}`);
  const acc = await readAccess();
  fs.mkdirSync(BW_DATA, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, BITWARDENCLI_APPDATA_DIR: BW_DATA, BW_NOINTERACTION: "true", BW_PW: acc.password,
  };
  const bw = (args: string[]) => run(process.execPath, [BW_JS, ...args], env);
  await bw(["config", "server", BW_SERVER]);
  const status = JSON.parse(await bw(["status"])).status as string;
  if (status === "unauthenticated") {
    if (acc.clientId && acc.clientSecret) {
      env.BW_CLIENTID = acc.clientId; env.BW_CLIENTSECRET = acc.clientSecret;
      await bw(["login", "--apikey"]);
    } else {
      return (await bw(["login", acc.email, "--passwordenv", "BW_PW", "--raw"])).trim();
    }
  }
  const session = (await bw(["unlock", "--passwordenv", "BW_PW", "--raw"])).trim();
  if (session.length < 20) throw new Error("Tresor konnte nicht entsperrt werden");
  await bw(["sync", "--session", session]);
  return session;
}

export async function getFtpLogin(slug: string): Promise<{ user: string; password: string }> {
  // Ausnahme/Notweg: FTP_PASSWORD_<KUERZEL> in der Umgebung (z. B. fuer Tests) hat Vorrang
  const envName = "FTP_PASSWORD_" + slug.toUpperCase().replace(/-/g, "_");
  if (process.env[envName]) return { user: "", password: process.env[envName] as string };

  const hit = cache.get(slug);
  if (hit) return hit;
  if (!sessionPromise) sessionPromise = openSession();
  let session: string;
  try { session = await sessionPromise; } catch (e) { sessionPromise = null; throw e; }
  const env: NodeJS.ProcessEnv = { ...process.env, BITWARDENCLI_APPDATA_DIR: BW_DATA, BW_NOINTERACTION: "true" };
  const name = `MCP FTP ${slug}`;
  let item;
  try {
    item = JSON.parse(await run(process.execPath, [BW_JS, "get", "item", name, "--session", session], env));
  } catch (e) {
    sessionPromise = null;
    throw new Error(`Tresor-Eintrag '${name}' nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
  }
  const login = { user: item?.login?.username || "", password: item?.login?.password || "" };
  if (!login.password) throw new Error(`Tresor-Eintrag '${name}' hat kein Passwort`);
  cache.set(slug, login);
  return login;
}
