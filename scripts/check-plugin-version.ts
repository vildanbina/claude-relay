import { readFileSync } from "node:fs";

type VersionedPlugin = {
    version: string;
    plugins?: Array<{ version?: string }>;
};

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

function fail(message: string): never {
    process.stderr.write(`version check failed: ${message}\n`);
    process.exit(1);
}

const packageVersion = readJson<{ version: string }>("package.json").version;
const pluginVersion = readJson<{ version: string }>(".claude-plugin/plugin.json").version;
const marketplace = readJson<VersionedPlugin>(".claude-plugin/marketplace.json");
const marketplaceVersion = marketplace.plugins?.[0]?.version;
const serverSource = readFileSync("src/channel/mcp-server.ts", "utf8");
const serverMatch = serverSource.match(/version:\s*"([^"]+)"/);
const serverVersion = serverMatch?.[1];

const versions = [
    ["package.json", packageVersion],
    [".claude-plugin/plugin.json", pluginVersion],
    [".claude-plugin/marketplace.json", marketplaceVersion],
    ["src/channel/mcp-server.ts", serverVersion],
] as const;

for (const [path, version] of versions) {
    if (!version) {
        fail(`${path} is missing a version`);
    }
    if (version !== packageVersion) {
        fail(`${path} has ${version}, expected ${packageVersion}`);
    }
}

process.stdout.write(`version check ok: ${packageVersion}\n`);
