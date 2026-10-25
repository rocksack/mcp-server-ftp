import { Client } from "basic-ftp";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface FtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
}

export class FtpClient {
  private client: Client;
  private config: FtpConfig;
  private tempDir: string;

  constructor(config: FtpConfig) {
    this.client = new Client(parseInt(process.env.FTP_TIMEOUT || "90000"));
    this.config = config;
    this.tempDir = path.join(os.tmpdir(), "mcp-ftp-temp");
    
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    
    this.client.ftp.verbose = false;
  }

  async connect(): Promise<void> {
    try {
      await this.client.access({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        secure: this.config.secure
      });
    } catch (error) {
      console.error("FTP connection error:", error);
      throw new Error(`Failed to connect to FTP server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    this.client.close();
  }

  async listDirectory(remotePath: string): Promise<Array<{name: string, type: string, size: number, modifiedDate: string}>> {
    try {
      await this.connect();
      const list = await this.client.list(remotePath);
      await this.disconnect();
      
      return list.map(item => ({
        name: item.name,
        type: item.type === 1 ? "file" : item.type === 2 ? "directory" : "other",
        size: item.size,
        modifiedDate: item.modifiedAt ? item.modifiedAt.toISOString() : ""
      }));
    } catch (error) {
      console.error("List directory error:", error);
      throw new Error(`Failed to list directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async downloadFile(remotePath: string): Promise<{filePath: string, content: string}> {
    try {
      await this.connect();
      const tempFilePath = path.join(this.tempDir, `download-${Date.now()}-${path.basename(remotePath)}`);
      await this.client.downloadTo(tempFilePath, remotePath);
      const content = fs.readFileSync(tempFilePath, 'utf8');
      await this.disconnect();
      return { filePath: tempFilePath, content };
    } catch (error) {
      console.error("Download file error:", error);
      throw new Error(`Failed to download file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async uploadFile(remotePath: string, content: string): Promise<boolean> {
    try {
      await this.connect();
      const tempFilePath = path.join(this.tempDir, `upload-${Date.now()}-${path.basename(remotePath)}`);
      fs.writeFileSync(tempFilePath, content);
      await this.client.uploadFrom(tempFilePath, remotePath);
      fs.unlinkSync(tempFilePath);
      await this.disconnect();
      return true;
    } catch (error) {
      console.error("Upload file error:", error);
      throw new Error(`Failed to upload file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async uploadFileFromPath(localPath: string, remotePath: string): Promise<boolean> {
    try {
      if (!fs.existsSync(localPath)) {
        throw new Error(`Local file not found: ${localPath}`);
      }
      await this.connect();
      await this.client.uploadFrom(localPath, remotePath);
      await this.disconnect();
      return true;
    } catch (error) {
      console.error("Upload file from path error:", error);
      throw new Error(`Failed to upload file from path: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async downloadFileToPath(remotePath: string, localPath: string): Promise<boolean> {
    try {
      const targetDir = path.dirname(localPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      await this.connect();
      await this.client.downloadTo(localPath, remotePath);
      await this.disconnect();
      return true;
    } catch (error) {
      console.error("Download file to path error:", error);
      throw new Error(`Failed to download file to path: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async createDirectory(remotePath: string): Promise<boolean> {
    try {
      await this.connect();
      await this.client.ensureDir(remotePath);
      await this.disconnect();
      return true;
    } catch (error) {
      console.error("Create directory error:", error);
      throw new Error(`Failed to create directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteFile(remotePath: string): Promise<boolean> {
    try {
      await this.connect();
      await this.client.remove(remotePath);
      await this.disconnect();
      return true;
    } catch (error) {
      console.error("Delete file error:", error);
      throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteDirectory(remotePath: string): Promise<boolean> {
    try {
      await this.connect();
      await this.client.removeDir(remotePath);
      await this.disconnect();
      return true;
    } catch (error) {
      console.error("Delete directory error:", error);
      throw new Error(`Failed to delete directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}