import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Seitenliste (ohne Passwoerter). Zentral auf der NAS, bei jedem Aufruf frisch gelesen.
// NAS nicht erreichbar -> letzte bekannte Liste aus dem lokalen Zwischenspeicher.
export interface Site {
  host: string;
  port?: number;
  user: string;
  secure?: boolean;
  timeout?: number;
  blocked?: boolean;
}

export interface SiteList {
  sites: Record<string, Site>;
  source: "nas" | "cache";
}

// Im Server fest gesperrt, unabhaengig von der Liste (MiReNa: nur ueber tools/ftp.mjs)
export const ALWAYS_BLOCKED = new Set(["mirena"]);

const LIST_FILE = process.env.FTP_SITES_FILE || "\\\\192.168.1.245\\mike\\claude-sync\\ftp-sites.json";
const CACHE_FILE =
  process.env.FTP_SITES_CACHE ||
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), "claude-ftp", "ftp-sites.cache.json");
const NAS_TIMEOUT_MS = 5000;

function readWithTimeout(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Zeitueberschreitung beim Lesen der Seitenliste")), NAS_TIMEOUT_MS);
    fs.promises.readFile(file, "utf8").then(
      (t) => { clearTimeout(timer); resolve(t); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function parse(text: string): Record<string, Site> {
  const obj = JSON.parse(text.replace(/^﻿/, ""));
  const sites = obj.sites;
  if (!sites || typeof sites !== "object") throw new Error("Seitenliste ohne Abschnitt 'sites'");
  return sites as Record<string, Site>;
}

export async function loadSites(): Promise<SiteList> {
  try {
    const text = await readWithTimeout(LIST_FILE);
    const sites = parse(text);
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, text);
    } catch { /* Zwischenspeicher ist nur Zusatz */ }
    return { sites, source: "nas" };
  } catch (nasError) {
    try {
      const sites = parse(fs.readFileSync(CACHE_FILE, "utf8"));
      return { sites, source: "cache" };
    } catch {
      throw new Error(
        `Seitenliste nicht lesbar (${LIST_FILE}: ${nasError instanceof Error ? nasError.message : String(nasError)}) und kein Zwischenspeicher vorhanden`
      );
    }
  }
}

export async function resolveSite(key: string): Promise<{ slug: string; site: Site }> {
  const slug = key.trim().toLowerCase();
  if (ALWAYS_BLOCKED.has(slug)) throw new Error(`Seite '${slug}' ist im Server gesperrt`);
  const { sites } = await loadSites();
  const site = sites[slug];
  if (!site) throw new Error(`Unbekannte Seite '${slug}'. Gueltige Seiten: list-sites`);
  if (site.blocked) throw new Error(`Seite '${slug}' ist in der Liste gesperrt`);
  return { slug, site };
}
