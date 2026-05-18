import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFileSync } from "node:child_process";
import { claudeSessionName, claudeSessionPath, defaultName, presetSessionName } from "../identity";
import { makeLogger } from "../logger";
import { HUB_SOCKET_PATH, type ServerMsg } from "../protocol";
import { bootstrapHub, type HubRole } from "./bootstrap";
import { createMcpServer, wireToolHandlers } from "./mcp-server";
import { createPendingBroadcasts } from "./pending-broadcasts";
import { createReconnector } from "./reconnect";
import { registerWithRetries } from "./register";
import { buildEmitNotification, wireHubRouting } from "./routing";
import { startSessionWatcher } from "./session-watcher";
import { TOOLS, type ToolSchema } from "./tool-schemas";
import {
    callTool as dispatchTool,
    renameWithHub,
    type ChannelContext,
    type ToolResult,
} from "./tools";

const log = makeLogger("channel");

const INSTRUCTIONS = [
    "If an incoming `<channel>` message is present, you MUST reply via relay_reply(ask_id, text) BEFORE handling any other user work. The peer session is blocked waiting on your reply. Exception: if the pending user work is destructive or irreversible, complete or confirm that first, then reply.",
    "Whenever an incoming `<channel>` message arrives (ask, reply, or broadcast), your first user-visible output that turn must quote the peer's full body verbatim in a fenced markdown block, prefixed with the sender name and kind (e.g. `peer-name (ask):`). The Claude Code TUI truncates tool-result panels, so plain assistant text is the only place the user actually sees the message. Quote first, then act.",
    "When an incoming reply to one of your asks contains a question directed back at you, surface that question to the user and offer to follow up with a new relay_ask(); do not end your turn without relaying the question-back.",
    "Pick the target with relay_peers() (match by name/cwd/branch); use relay_ask for one peer, relay_broadcast for all.",
    "If a relay_ask fails (peer_not_found, peer_gone, timeout), surface the failure to the user and let them decide. Never broadcast as a fallback: relay_broadcast hits every session on the machine, including ones on unrelated projects, and is almost always the wrong recovery.",
    'If the user refers to a peer by pronoun or demonstrative ("them", "that session", "it"), carry forward the most recent `to:` value. If ambiguous across multiple peers, call relay_peers and confirm with the user before sending.',
    "Trust tool defaults. Only override an argument when the user gave an explicit value for that exact argument; descriptive words about the answer never change tool arguments.",
].join(" ");

const CAPABILITIES = {
    tools: {},
    experimental: { "claude/channel": {} },
} as const;

function detectGitBranch(): string {
    try {
        return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
    } catch {
        return "";
    }
}

export type StartChannelOptions = {
    socketPath?: string;
    hubSpawner?: (socketPath: string) => Promise<{ close: () => Promise<void> }>;
    onIncoming?: (msg: ServerMsg) => void;
    onNotification?: (n: { method: string; params: Record<string, unknown> }) => void;
    now?: () => number;
    transport?: { connect: (server: Server) => Promise<void>; close?: () => Promise<void> };
    requestTimeoutMs?: number;
    broadcastTimeoutMs?: number;
    skipRegister?: boolean;
};

export type ChannelHandle = {
    close: () => Promise<void>;
    getName: () => string;
    getHubRole: () => HubRole;
    getCapabilities: () => Record<string, unknown>;
    getInstructions: () => string;
    getToolNames: () => string[];
    getToolSchemas: () => ToolSchema[];
    callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
};

export async function startChannel(opts: StartChannelOptions = {}): Promise<ChannelHandle> {
    const socketPath = opts.socketPath ?? HUB_SOCKET_PATH;
    let bootstrap = await bootstrapHub(socketPath, opts.hubSpawner);

    const onIncoming = opts.onIncoming;
    const wireIncoming = (h: typeof bootstrap.hub) => {
        if (!onIncoming) return;
        h.onMessage((m) => {
            if (
                m.type === "incoming_ask" ||
                m.type === "incoming_reply" ||
                m.type === "broadcast_ack"
            ) {
                onIncoming(m);
            }
        });
    };
    wireIncoming(bootstrap.hub);

    const gitBranch = detectGitBranch();
    const onDiskName = claudeSessionName();
    const candidate = presetSessionName() ?? onDiskName ?? defaultName(process.cwd());
    let name = opts.skipRegister
        ? candidate
        : await registerWithRetries(
              bootstrap.hub,
              { cwd: process.cwd(), git_branch: gitBranch },
              candidate,
          );

    log.info("channel_start", {
        socketPath,
        name,
        cwd: process.cwd(),
        pid: process.pid,
        git_branch: gitBranch,
        hubRole: bootstrap.hubRole,
    });

    const pendingBroadcasts = createPendingBroadcasts();
    const nowFn = opts.now ?? Date.now;

    const { server, toolSchemas } = createMcpServer(
        CAPABILITIES as Record<string, unknown>,
        INSTRUCTIONS,
    );

    const emitNotification = buildEmitNotification({
        onNotification: opts.onNotification,
        transport: opts.transport,
        server,
    });

    let closed = false;

    const reconnector = createReconnector({
        socketPath,
        hubSpawner: opts.hubSpawner,
        getCwd: () => process.cwd(),
        getGitBranch: () => gitBranch,
        skipRegister: opts.skipRegister,
        getName: () => name,
        setName: (n) => {
            name = n;
        },
        onReconnect: (next) => {
            const prev = bootstrap;
            bootstrap = next;
            wireIncoming(next.hub);
            wireHubRouting(next.hub, pendingBroadcasts, emitNotification);
            reconnector.wire(next.hub);
            prev.hub.close();
            if (prev.hubHandle) {
                void prev.hubHandle.close().catch((e: unknown) => {
                    log.warn("prev_hub_handle_close_failed", {
                        err: e instanceof Error ? e.message : String(e),
                    });
                });
            }
        },
    });

    wireHubRouting(bootstrap.hub, pendingBroadcasts, emitNotification);
    reconnector.wire(bootstrap.hub);

    const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    const broadcastTimeoutMs = opts.broadcastTimeoutMs ?? 300_000;

    const ctx: ChannelContext = {
        getHub: () => bootstrap.hub,
        pendingBroadcasts,
        getName: () => name,
        setName: (n: string) => {
            name = n;
        },
        nowFn,
        counters: { broadcast: 0 },
        broadcastTimeoutMs,
        requestTimeoutMs,
    };

    const callTool = wireToolHandlers(server, toolSchemas, (toolName, args) =>
        dispatchTool(ctx, toolName, args),
    );

    const sessionWatcher = opts.skipRegister
        ? null
        : startSessionWatcher({
              sessionPath: claudeSessionPath(),
              initialName: onDiskName,
              onName: async (newName) => {
                  if (newName === name) return;
                  const result = await renameWithHub(ctx, newName);
                  if (!result.ok) {
                      log.warn("session_watcher_rename_failed", {
                          attempted: newName,
                          code: result.code,
                      });
                  }
              },
          });

    const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        log.info("channel_close");
        if (sessionWatcher !== null) sessionWatcher.close();
        reconnector.close();
        pendingBroadcasts.clear();
        try {
            bootstrap.hub.close();
        } catch {}
        try {
            await server.close();
        } catch {}
        if (opts.transport?.close) {
            try {
                await opts.transport.close();
            } catch {}
        }
        if (bootstrap.hubHandle) {
            try {
                await bootstrap.hubHandle.close();
            } catch {}
        }
    };

    // If the MCP transport closes (e.g. parent Claude Code died -> stdin EOF),
    // tear down the hub connection so the hub reaps this peer immediately.
    server.onclose = () => {
        log.info("mcp_transport_closed");
        void close();
    };

    if (opts.transport) {
        await opts.transport.connect(server);
    }

    return {
        close,
        getName: () => name,
        getHubRole: () => bootstrap.hubRole,
        getCapabilities: () => ({ ...CAPABILITIES }),
        getInstructions: () => INSTRUCTIONS,
        getToolNames: () => TOOLS.map((t) => t.name),
        getToolSchemas: () => toolSchemas.map((s) => ({ ...s, inputSchema: { ...s.inputSchema } })),
        callTool,
    };
}

export async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await startChannel({
        transport: {
            connect: (server) => server.connect(transport),
            close: () => transport.close(),
        },
    });
}
