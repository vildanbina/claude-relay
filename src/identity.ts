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

export function claudeSessionName(opts: ClaudeSessionNameOptions = {}): string | null {
    // CLAUDE_RELAY_PRESET_NAME lets the parent process pre-set the peer name
    // for a Claude session before it spawns. Useful for orchestrators that
    // spawn many CC sessions and need each to register under a deterministic,
    // human-meaningful name (e.g. "home-office-<sessionId>") instead of the
    // directory-basename fallback.
    const presetName = process.env.CLAUDE_RELAY_PRESET_NAME;
    if (presetName) {
        const sanitized = sanitizeSessionName(presetName);
        if (sanitized) return sanitized;
    }
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
