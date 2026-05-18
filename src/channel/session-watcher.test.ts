import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeSessionName } from "../identity";
import { startSessionWatcher } from "./session-watcher";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Long enough for fs events to flush + the 50ms debounce.
const FLUSH_MS = 150;

describe("startSessionWatcher", () => {
    let tmpDir: string;
    let sessionPath: string;
    const closers: Array<() => void> = [];

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sw-test-"));
        sessionPath = path.join(tmpDir, "1234.json");
    });

    afterEach(() => {
        while (closers.length) {
            const c = closers.pop();
            try {
                c?.();
            } catch {}
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("fires once when session file appears after startup (real claudeSessionName)", async () => {
        const received: string[] = [];
        const w = startSessionWatcher({
            sessionPath,
            onName: async (n) => {
                received.push(n);
            },
        });
        closers.push(() => w.close());

        await wait(20);
        expect(received).toEqual([]);

        fs.writeFileSync(sessionPath, JSON.stringify({ name: "appeared" }));
        await wait(FLUSH_MS);

        expect(received).toEqual(["appeared"]);
    });

    test("fires with new name when name changes", async () => {
        fs.writeFileSync(sessionPath, JSON.stringify({ name: "first" }));
        const received: string[] = [];
        const w = startSessionWatcher({
            sessionPath,
            onName: async (n) => {
                received.push(n);
            },
        });
        closers.push(() => w.close());

        // Simulate the initial registration already used "first".
        // The watcher should still report "first" when it first observes a
        // change event, but since no change event has fired yet, received
        // is empty until we rewrite.
        await wait(FLUSH_MS);

        fs.writeFileSync(sessionPath, JSON.stringify({ name: "second" }));
        await wait(FLUSH_MS);

        // Last emitted name should be "second"; "first" may or may not be
        // emitted depending on whether fs.watch catches the initial state,
        // but the important guarantee is we end up with "second".
        expect(received.at(-1)).toBe("second");
    });

    test("dedupes: identical events emit at most once per distinct name", async () => {
        const received: string[] = [];
        let reads = 0;
        const w = startSessionWatcher({
            sessionPath,
            onName: async (n) => {
                received.push(n);
            },
            readName: (p) => {
                reads++;
                try {
                    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { name?: unknown };
                    return typeof parsed.name === "string" ? parsed.name : null;
                } catch {
                    return null;
                }
            },
        });
        closers.push(() => w.close());

        fs.writeFileSync(sessionPath, JSON.stringify({ name: "dup" }));
        await wait(FLUSH_MS);

        // Touch the file repeatedly; name does not change.
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(sessionPath, JSON.stringify({ name: "dup" }));
            await wait(20);
        }
        await wait(FLUSH_MS);

        const dupCount = received.filter((n) => n === "dup").length;
        expect(dupCount).toBe(1);
        expect(reads).toBeGreaterThan(0);
    });

    test("recovers after file is deleted and recreated", async () => {
        fs.writeFileSync(sessionPath, JSON.stringify({ name: "alpha" }));
        const received: string[] = [];
        const w = startSessionWatcher({
            sessionPath,
            onName: async (n) => {
                received.push(n);
            },
        });
        closers.push(() => w.close());
        await wait(FLUSH_MS);

        fs.rmSync(sessionPath, { force: true });
        await wait(FLUSH_MS);

        fs.writeFileSync(sessionPath, JSON.stringify({ name: "beta" }));
        await wait(FLUSH_MS);

        expect(received.at(-1)).toBe("beta");
    });

    test("watcher errors in onName do not crash the channel", async () => {
        const errors: unknown[] = [];
        const received: string[] = [];
        const w = startSessionWatcher({
            sessionPath,
            onName: async (n) => {
                received.push(n);
                if (n === "boom") throw new Error("onName failed");
            },
            logError: (err) => errors.push(err),
        });
        closers.push(() => w.close());

        fs.writeFileSync(sessionPath, JSON.stringify({ name: "boom" }));
        await wait(FLUSH_MS);

        expect(received).toContain("boom");
        expect(errors.length).toBeGreaterThanOrEqual(1);

        // Subsequent distinct names still get through after an earlier error.
        fs.writeFileSync(sessionPath, JSON.stringify({ name: "ok" }));
        await wait(FLUSH_MS);
        expect(received.at(-1)).toBe("ok");
    });

    test("no-op when parent directory does not exist (no throw)", () => {
        const bogus = path.join(tmpDir, "nope", "deep", "1234.json");
        const errors: unknown[] = [];
        let w: ReturnType<typeof startSessionWatcher> | null = null;
        expect(() => {
            w = startSessionWatcher({
                sessionPath: bogus,
                onName: async () => {},
                logError: (err) => errors.push(err),
            });
        }).not.toThrow();
        if (w !== null) closers.push(() => (w as ReturnType<typeof startSessionWatcher>).close());
        expect(errors.length).toBeGreaterThan(0);
    });

    test("null readName result does not dispatch", async () => {
        const received: string[] = [];
        const w = startSessionWatcher({
            sessionPath,
            onName: async (n) => {
                received.push(n);
            },
            readName: () => null,
        });
        closers.push(() => w.close());

        fs.writeFileSync(sessionPath, JSON.stringify({ name: "ignored" }));
        await wait(FLUSH_MS);
        expect(received).toEqual([]);
    });

    test("initialName seeds dedupe: no dispatch if file matches registered name", async () => {
        fs.writeFileSync(sessionPath, JSON.stringify({ name: "foo-2" }));
        const received: string[] = [];
        const w = startSessionWatcher({
            sessionPath,
            initialName: "foo-2",
            onName: async (n) => {
                received.push(n);
            },
        });
        closers.push(() => w.close());

        fs.writeFileSync(sessionPath, JSON.stringify({ name: "foo-2" }));
        await wait(FLUSH_MS);
        expect(received).toEqual([]);
    });

    test("reconciles event that arrives during a slow onName (no lost update)", async () => {
        const received: string[] = [];
        let calls = 0;
        const w = startSessionWatcher({
            sessionPath,
            onName: async (n) => {
                calls++;
                if (calls === 1) {
                    fs.writeFileSync(sessionPath, JSON.stringify({ name: "second" }));
                    await wait(200);
                }
                received.push(n);
            },
        });
        closers.push(() => w.close());

        fs.writeFileSync(sessionPath, JSON.stringify({ name: "first" }));
        await wait(500);

        expect(received).toEqual(["first", "second"]);
    });

    test("serializes dispatches: only one onName in flight at a time", async () => {
        const received: string[] = [];
        let active = 0;
        let maxActive = 0;
        const w = startSessionWatcher({
            sessionPath,
            onName: async (n) => {
                active++;
                maxActive = Math.max(maxActive, active);
                await wait(100);
                received.push(n);
                active--;
            },
        });
        closers.push(() => w.close());

        fs.writeFileSync(sessionPath, JSON.stringify({ name: "a" }));
        await wait(70);
        fs.writeFileSync(sessionPath, JSON.stringify({ name: "b" }));
        await wait(300);

        expect(maxActive).toBe(1);
    });

    test("CLAUDE_RELAY_PRESET_NAME env does not block /rename propagation via watcher", async () => {
        const prior = process.env.CLAUDE_RELAY_PRESET_NAME;
        process.env.CLAUDE_RELAY_PRESET_NAME = "preset-name";
        try {
            const received: string[] = [];
            const w = startSessionWatcher({
                sessionPath,
                initialName: "preset-name",
                onName: async (n) => {
                    received.push(n);
                },
                readName: (p) => claudeSessionName({ path: p }),
            });
            closers.push(() => w.close());

            fs.writeFileSync(sessionPath, JSON.stringify({ name: "renamed-via-cmd" }));
            await wait(FLUSH_MS);

            expect(received.at(-1)).toBe("renamed-via-cmd");
        } finally {
            if (prior === undefined) delete process.env.CLAUDE_RELAY_PRESET_NAME;
            else process.env.CLAUDE_RELAY_PRESET_NAME = prior;
        }
    });

    test("ignores events for files other than sessionPath basename", async () => {
        const received: string[] = [];
        const w = startSessionWatcher({
            sessionPath,
            onName: async (n) => {
                received.push(n);
            },
            readName: () => "should-not-fire",
        });
        closers.push(() => w.close());

        const sibling = path.join(tmpDir, "other.json");
        fs.writeFileSync(sibling, JSON.stringify({ name: "nope" }));
        await wait(FLUSH_MS);
        expect(received).toEqual([]);
    });
});
