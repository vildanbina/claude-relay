import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function defaultName(cwd: string): string {
    const raw = path.basename(cwd);
    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug === "" ? "relay" : slug;
}

export type ClaudeSessionPathOptions = {
    ppid?: number;
    home?: string;
};

export function claudeSessionPath(opts: ClaudeSessionPathOptions = {}): string {
    return path.join(
        opts.home ?? os.homedir(),
        ".claude",
        "sessions",
        `${opts.ppid ?? process.ppid}.json`,
    );
}

export type ClaudeSessionNameOptions = {
    path?: string;
    ppid?: number;
    home?: string;
};

export function sanitizeSessionName(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.length > 64) return null;
    return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

// CLAUDE_RELAY_PRESET_NAME lets a parent process pre-set the peer name before
// the Claude session spawns. Used only as the initial registration candidate;
// the session-file watcher stays authoritative so /rename and /relay-rename
// still work for preset sessions.
export function presetSessionName(): string | null {
    const raw = process.env.CLAUDE_RELAY_PRESET_NAME;
    if (!raw) return null;
    return sanitizeSessionName(raw);
}

export function claudeSessionName(opts: ClaudeSessionNameOptions = {}): string | null {
    const sessionPath = opts.path ?? claudeSessionPath({ ppid: opts.ppid, home: opts.home });
    try {
        const stat = fs.statSync(sessionPath);
        if (!stat.isFile()) return null;
    } catch {
        return null;
    }
    let raw: string;
    try {
        raw = fs.readFileSync(sessionPath, "utf8");
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) return null;
    const { name } = parsed;
    if (typeof name !== "string") return null;
    return sanitizeSessionName(name);
}
