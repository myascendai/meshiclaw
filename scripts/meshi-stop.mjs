#!/usr/bin/env node
/**
 * MeshiClaw Gateway Stop
 *
 * Stops and removes the OpenClaw gateway LaunchAgent.
 */

import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import chalk from "chalk";

const accent = chalk.hex("#ff6b35");
const dim = chalk.dim;

function banner() {
  const line = dim("\u2500".repeat(52));
  console.log();
  console.log(line);
  console.log(accent.bold("  \u{1F35C}  MeshiClaw"), dim("\u2014"), dim.italic("gateway stop"));
  console.log(line);
  console.log();
}

async function main() {
  banner();
  p.intro(accent("Stopping gateway"));

  const uid = process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;
  const label = "ai.openclaw.gateway";
  const plistPath = `${process.env.HOME}/Library/LaunchAgents/${label}.plist`;

  // Check if LaunchAgent is loaded
  let isLoaded = false;
  try {
    execSync(`launchctl print ${domain}/${label}`, { stdio: "ignore" });
    isLoaded = true;
  } catch {}

  if (!isLoaded) {
    p.log.info(dim("LaunchAgent not loaded"));
  } else {
    // Bootout
    try {
      execSync(`launchctl bootout ${domain}/${label}`, { stdio: "pipe" });
      p.log.success(dim("Stopped LaunchAgent"));
    } catch (err) {
      const output = err.stdout?.toString() || err.stderr?.toString() || "";
      if (!output.toLowerCase().includes("no such process")) {
        p.log.warn(dim(`bootout failed: ${output.trim()}`));
      }
    }

    // Unload
    try {
      execSync(`launchctl unload ${plistPath}`, { stdio: "pipe" });
      p.log.success(dim("Unloaded LaunchAgent"));
    } catch {}
  }

  // Remove plist
  const { unlinkSync, existsSync } = await import("node:fs");
  if (existsSync(plistPath)) {
    try {
      unlinkSync(plistPath);
      p.log.success(dim(`Removed ${plistPath}`));
    } catch (err) {
      p.log.warn(dim(`Failed to remove plist: ${err.message}`));
    }
  }

  // Kill any process on port 18789
  const GATEWAY_PORT = 18789;
  try {
    const pids = execSync(`lsof -ti :${GATEWAY_PORT}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .filter(Boolean);

    if (pids.length) {
      const unique = [...new Set(pids)];
      for (const pid of unique) {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {}
      }
      p.log.warn(dim(`Killed process on port ${GATEWAY_PORT} (pid ${unique.join(", ")})`));
    }
  } catch {
    // No process on port — good
  }

  console.log();
  p.outro(accent.bold("Gateway stopped"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
