import ftp from "basic-ftp";
import fs from "fs";
import path from "path";
import cliProgress from "cli-progress";
import {
  FTP_HOST,
  FTP_USER,
  FTP_PASS,
  FTP_FOLDER_SEND,
  LOCAL_FOLDER_SEND,
  LOCAL_FOLDER_RECV,
  FTP_FOLDER_RECV,
  FILE_PATTERN_RECV,
  BUCKET_FOLDER_RECV,
  SHORT_INTERVAL_MS,
  MIDDLE_INTERVAL_MS,
} from "./const.js";
import { b2_uploadFile } from "./b2.js";
import { notify } from "./mail.js";

const FTP_CONFIG = {
  host: FTP_HOST,
  user: FTP_USER,
  password: FTP_PASS,
  secure: true,
  secureOptions: { rejectUnauthorized: false },
};

/**
 * Upload file while a second FTP client monitors remote folder.
 */
export async function f2_uploadFile(filename) {
  const FTP_FOLDER = FTP_FOLDER_SEND;
  const LOCAL_FOLDER = LOCAL_FOLDER_SEND;

  let ret = false;

  const localPath = path.join(LOCAL_FOLDER, filename);
  if (!fs.existsSync(localPath))
    throw new Error(`Local file not found: ${localPath}`);

  // basic-ftp default timeout is 30s. GitHub Actions runners can be slower,
  // so large uploads may hit timeouts / connection resets.
  const FTP_TIMEOUT_MS = Number(process.env.FTP_TIMEOUT_MS ?? 10 * 60 * 1000);

  const uploader = new ftp.Client(FTP_TIMEOUT_MS);
  const watcher = new ftp.Client(FTP_TIMEOUT_MS);

  const verbose = process.env.FTP_VERBOSE === "1";
  uploader.ftp.verbose = verbose;
  watcher.ftp.verbose = verbose;

  const totalBytes = fs.statSync(localPath).size;

  const bar = new cliProgress.SingleBar({
    format: `Uploading {filename} [{bar}] {percentage}% | {speed} KB/s`,
    barCompleteChar: "█",
    barIncompleteChar: "░",
    hideCursor: true,
  });

  bar.start(100, 0, { filename, speed: "0" });

  let lastBytes = 0;
  let lastTime = Date.now();

  uploader.trackProgress((info) => {
    const now = Date.now();
    const deltaBytes = info.bytes - lastBytes;
    const deltaTime = (now - lastTime) / 1000 || 1;
    const speedKBs = (deltaBytes / 1024 / deltaTime).toFixed(1);
    const pct = (info.bytes / totalBytes) * 100;
    bar.update(pct, { speed: speedKBs });
    lastBytes = info.bytes;
    lastTime = now;
  });

  try {
    await uploader.access(FTP_CONFIG);
    await watcher.access(FTP_CONFIG);
    await uploader.cd(FTP_FOLDER);
    await watcher.cd(FTP_FOLDER);

    // Optional: TCP keepalive (helps with some NAT/load-balancers killing idle connections)
    if (uploader.ftp.socket?.setKeepAlive) {
      uploader.ftp.socket.setKeepAlive(true, 10_000);
    }
    if (watcher.ftp.socket?.setKeepAlive) {
      watcher.ftp.socket.setKeepAlive(true, 10_000);
    }

    console.log(
      `✅ Connected to FTP. Starting upload and polling... (timeout=${FTP_TIMEOUT_MS}ms)`
    );

    // Start upload + watcher loop concurrently.
    // - If watcher reports stability first, still await upload to ensure it really completed.
    // - If upload completes first, then await watcher to confirm stabilization.
    const uploadPromise = uploader
      .uploadFrom(localPath, filename)
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, err }));

    const watchPromise = waitForCheckingFile(watcher, filename);

    const first = await Promise.race([watchPromise, uploadPromise]);

    if (first?.success) {
      const uploadRes = await uploadPromise;
      if (!uploadRes.ok) throw uploadRes.err;

      console.log(
        `✅ File stabilized: ${first.remoteName} (${first.size} bytes)`
      );
      ret = true;
    } else if (first?.ok === false) {
      throw first.err;
    } else {
      // upload finished first (or watcher returned non-success); wait for stabilization
      const watchRes = await watchPromise;
      if (watchRes?.success) {
        console.log(
          `✅ File stabilized: ${watchRes.remoteName} (${watchRes.size} bytes)`
        );
        ret = true;
      } else {
        console.warn(
          "⚠️  Upload finished but no stable file detected yet (watcher timed out)."
        );
      }
    }

    // bar.update(100);
    bar.stop();
  } catch (err) {
    bar.stop();
    console.error("❌ Error (f2_uploadFile):", {
      message: err?.message,
      code: err?.code,
      name: err?.name,
      stack: err?.stack,
    });
  } finally {
    uploader.close();
    watcher.close();
  }

  return ret;
}

/**
 * Waits until `filename` or `filename_checking` appears and stops changing size.
 */
async function waitForCheckingFile(
  client,
  filename,
  interval = SHORT_INTERVAL_MS,
  maxWait = 7200000 // 2hr
) {
  const checkName = `${filename}_checking`;
  let lastSize = -1;
  let stableCount = 0;
  const start = Date.now();

  console.log(`🔍 Watching FTP for ${filename} or ${checkName}`);

  while (Date.now() - start < maxWait) {
    const list = await client.list();
    const target =
      list.find((f) => f.name === filename) ||
      list.find((f) => f.name === checkName);

    if (target) {
      if (target.size === lastSize) stableCount++;
      else stableCount = 0;
      lastSize = target.size;

      if (stableCount >= 2) {
        console.log(
          `✅ Upload is stable now: ${target.name} (${target.size} bytes).`
        );
        return { success: true, remoteName: target.name, size: target.size };
      }
      console.log(`⏳ Found ${target.name} (${target.size} bytes). Waiting...`);
    } else {
      console.log("🚨 File not found yet...");
    }

    console.log(`⏳ Waiting ${interval / 60 / 1000} min...`);

    await new Promise((r) => setTimeout(r, interval));
  }

  console.log(`😒 Upload is still unstable after ${maxWait / 1000 / 1000}m`);
  return { success: false };
}

export async function f2_downloadFile() {
  const FTP_FOLDER = FTP_FOLDER_RECV;
  const LOCAL_FOLDER = LOCAL_FOLDER_RECV;
  const FILE_PATTERN = FILE_PATTERN_RECV;

  // basic-ftp default timeout is 30s. GitHub Actions runners can be slower,
  // so large downloads may hit timeouts / connection resets.
  const FTP_TIMEOUT_MS = Number(process.env.FTP_TIMEOUT_MS ?? 10 * 60 * 1000);

  const client = new ftp.Client(FTP_TIMEOUT_MS);
  client.ftp.verbose = process.env.FTP_VERBOSE === "1";

  // Setup progress bar
  const bar = new cliProgress.SingleBar({
    format: "⬇️  {filename} [{bar}] {percentage}% | {speed} KB/s",
    barCompleteChar: "█",
    barIncompleteChar: "░",
    hideCursor: true,
  });

  let totalBytes = 0;
  let lastBytes = 0;
  let lastTime = Date.now();

  // Track FTP progress
  client.trackProgress((info) => {
    const now = Date.now();
    const deltaBytes = info.bytes - lastBytes;
    const deltaTime = (now - lastTime) / 1000 || 1;
    const speedKBs = (deltaBytes / 1024 / deltaTime).toFixed(1);
    const pct = totalBytes ? (info.bytes / totalBytes) * 100 : 0;
    bar.update(pct, { speed: speedKBs });
    lastBytes = info.bytes;
    lastTime = now;
  });

  try {
    await client.access(FTP_CONFIG);

    // Optional: TCP keepalive (helps with some NAT/load-balancers killing idle connections)
    if (client.ftp.socket?.setKeepAlive) {
      client.ftp.socket.setKeepAlive(true, 10_000);
    }

    console.log(`✅ Connected to ${FTP_HOST} (timeout=${FTP_TIMEOUT_MS}ms)`);
    await client.cd(FTP_FOLDER);

    const fileList = await client.list();
    const matchingFiles = fileList.filter((f) => FILE_PATTERN.test(f.name));

    if (matchingFiles.length === 0) {
      console.log("⚠️  No matching files found.");
      return;
    }

    if (!fs.existsSync(LOCAL_FOLDER)) {
      fs.mkdirSync(LOCAL_FOLDER, { recursive: true });
    }

    for (const file of matchingFiles) {
      const localPath = path.join(LOCAL_FOLDER, file.name);

      let attempt = 0;
      let success = false;
      while (attempt < 3 && !success) {
        attempt++;
        console.log(`📥 Attempt ${attempt} for ${file.name}...`);

        console.log(`⬇️  Downloading ${file.name} → ${localPath}`);

        // initialize for this file
        totalBytes = file.size || 0;
        lastBytes = 0;
        lastTime = Date.now();
        bar.start(100, 0, { filename: file.name, speed: "0" });

        try {
          // NOTE: basic-ftp throws on errors/timeouts, it doesn't return {success:false}.
          await client.downloadTo(localPath, file.name);

          // Basic sanity check: verify size (detects truncated downloads where server doesn't error)
          const downloadedBytes = fs.existsSync(localPath)
            ? fs.statSync(localPath).size
            : 0;
          if (file.size && downloadedBytes !== file.size) {
            throw new Error(
              `Downloaded size mismatch: expected=${file.size} actual=${downloadedBytes}`
            );
          }

          success = true;
          await notify(
            `✅ Download complete: ${file.name}, attempted ${attempt}`
          );
        } catch (err) {
          console.error("🚨 Download attempt failed", {
            file: file.name,
            attempt,
            message: err?.message,
            code: err?.code,
            name: err?.name,
            stack: err?.stack,
          });

          // After ECONNRESET/timeout, the client is usually closed internally.
          // Reconnect before retrying.
          try {
            if (!client.closed) client.close();
          } catch (_) {
            // ignore
          }

          if (attempt < 3) {
            console.log("⏳ Waiting 5 minutes before retry...");
            await new Promise((res) => setTimeout(res, MIDDLE_INTERVAL_MS));
            await client.access(FTP_CONFIG);
            await client.cd(FTP_FOLDER);
          } else {
            await notify(
              `🚨 All download attempts are done for ${file.name}, attempted ${attempt}, upload to b2 will happen now.`
            );
          }
        } finally {
          // bar.update(100, { speed: "0" });
          bar.stop();
        }
      }

      // upload to destination
      await b2_uploadFile(localPath, BUCKET_FOLDER_RECV).catch(console.error);

      // optional delete
      await client.remove(file.name);
      await notify(`🗑️ Deleted ${file.name} from FTP server.`);
    }

    console.log("✅ All download/upload/delete complete.");
  } catch (err) {
    bar.stop();
    console.error("🚨 Error (f2_downloadFile):", {
      message: err?.message,
      code: err?.code,
      name: err?.name,
      stack: err?.stack,
    });
  } finally {
    client.close();
  }
}
