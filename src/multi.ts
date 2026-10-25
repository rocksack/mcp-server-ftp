#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client } from "basic-ftp";
import { Readable, Writable } from "stream";
import * as fs from "fs";
import * as path from "path";
import { loadSites, resolveSite } from "./sites.js";
import { getFtpLogin } from "./ftpcrypt.js";

// Ein Konnektor fuer alle Seiten: jedes Werkzeug nimmt 'site'. Neue Verbindung je Aufruf.
const server = new McpServer({ name: "ftp", version: "2.0.0" });

const site = z.string().describe("Site key, see list-sites");

async function withFtp<T>(siteKey: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const { slug, site: s } = await resolveSite(siteKey);
  const login = await getFtpLogin(slug, s);
  const client = new Client(s.timeout ?? parseInt(process.env.FTP_TIMEOUT || "90000"));
  client.ftp.verbose = false;
  try {
    await client.access({
      host: s.host,
      port: s.port ?? 21,
      user: login.user || s.user,
      password: login.password,
      secure: s.secure ?? false,
    });
    return await fn(client);
  } finally {
    client.close();
  }
}

function ok(text: string) { return { content: [{ type: "text" as const, text }] }; }
function fail(prefix: string, e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: `${prefix}: ${e instanceof Error ? e.message : String(e)}` }] };
}
function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

server.tool("list-sites", "List available FTP site keys", {}, async () => {
  try {
    const { sites, source } = await loadSites();
    const keys = Object.keys(sites).filter((k) => !sites[k].blocked).sort();
    return ok(`${keys.length} sites (list from ${source}): ${keys.join(", ")}`);
  } catch (e) { return fail("Error listing sites", e); }
});

server.tool("list-directory", "List an FTP directory", { site, remotePath: z.string() }, async ({ site: k, remotePath }) => {
  try {
    const list = await withFtp(k, (c) => c.list(remotePath));
    const lines = list.map((i) =>
      `${i.type === 2 ? "[DIR]" : "[FILE]"} ${i.name}${i.type === 1 ? ` (${fmtSize(i.size)})` : ""} - ${i.modifiedAt ? i.modifiedAt.toISOString() : ""}`);
    const dirs = list.filter((i) => i.type === 2).length;
    return ok(`Directory listing for: ${remotePath}\n\n${lines.join("\n")}\n\nTotal: ${list.length} items (${dirs} directories, ${list.filter((i) => i.type === 1).length} files)`);
  } catch (e) { return fail("Error listing directory", e); }
});

server.tool("download-file", "Download a text file from FTP", { site, remotePath: z.string() }, async ({ site: k, remotePath }) => {
  try {
    const chunks: Buffer[] = [];
    const sink = new Writable({ write(ch, _e, cb) { chunks.push(Buffer.from(ch)); cb(); } });
    await withFtp(k, (c) => c.downloadTo(sink, remotePath));
    return ok(`File content of ${remotePath}:\n\n${Buffer.concat(chunks).toString("utf8")}`);
  } catch (e) { return fail("Error downloading file", e); }
});

server.tool("download-file-to-path", "Download an FTP file to a local path", { site, remotePath: z.string(), localPath: z.string() }, async ({ site: k, remotePath, localPath }) => {
  try {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await withFtp(k, (c) => c.downloadTo(localPath, remotePath));
    return ok(`Downloaded ${remotePath} to ${localPath} (${fmtSize(fs.statSync(localPath).size)})`);
  } catch (e) { return fail("Error downloading file", e); }
});

server.tool("upload-file", "Upload small text content to FTP", { site, remotePath: z.string(), content: z.string() }, async ({ site: k, remotePath, content }) => {
  try {
    await withFtp(k, (c) => c.uploadFrom(Readable.from([Buffer.from(content, "utf8")]), remotePath));
    return ok(`File successfully uploaded to ${remotePath}`);
  } catch (e) { return fail("Error uploading file", e); }
});

server.tool("upload-file-from-path", "Upload a local file to FTP (large or binary files); verifies remote size", { site, localPath: z.string(), remotePath: z.string() }, async ({ site: k, localPath, remotePath }) => {
  try {
    if (!fs.existsSync(localPath)) throw new Error(`Local file not found: ${localPath}`);
    const local = fs.statSync(localPath).size;
    const remote = await withFtp(k, async (c) => {
      await c.uploadFrom(localPath, remotePath);
      try { return await c.size(remotePath); } catch { return -1; }
    });
    const check = remote < 0 ? "remote size not verifiable" : remote === local ? `size verified (${local} bytes)` : `SIZE MISMATCH local ${local} / remote ${remote}`;
    return remote >= 0 && remote !== local
      ? fail("Upload size mismatch", new Error(check))
      : ok(`Uploaded ${localPath} to ${remotePath}: ${check}`);
  } catch (e) { return fail("Error uploading file", e); }
});

server.tool("create-directory", "Create an FTP directory (with parents)", { site, remotePath: z.string() }, async ({ site: k, remotePath }) => {
  try {
    await withFtp(k, (c) => c.ensureDir(remotePath));
    return ok(`Directory created: ${remotePath}`);
  } catch (e) { return fail("Error creating directory", e); }
});

server.tool("delete-file", "Delete an FTP file", { site, remotePath: z.string() }, async ({ site: k, remotePath }) => {
  try {
    await withFtp(k, (c) => c.remove(remotePath));
    return ok(`File deleted: ${remotePath}`);
  } catch (e) { return fail("Error deleting file", e); }
});

server.tool("delete-directory", "Delete an FTP directory (recursive)", { site, remotePath: z.string() }, async ({ site: k, remotePath }) => {
  try {
    await withFtp(k, (c) => c.removeDir(remotePath));
    return ok(`Directory deleted: ${remotePath}`);
  } catch (e) { return fail("Error deleting directory", e); }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
