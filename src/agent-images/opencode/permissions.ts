// D-196's tool list as OpenCode permissions (docs/spikes/opencode-runtime.md, check 3). The bot
// files keep Claude Code's tool names; this maps them. OpenCode applies the last matching rule,
// so `"*": "deny"` comes first and every allowed tool after it. Only `allow` and `deny` are
// written: in `opencode run` an `ask` is rejected and ends the run with no final text.
// A name with no mapping, a bare `Bash` and `Bash(*)` are refused, so the run never gets more
// than its bot file lists. Errors name the tool's position in the list, never its text.
//
// The read-only context tools the task lists (ADR 0119 slice 3c) come from the run's own MCP
// server, `foreman` (./context-mcp.ts), so OpenCode names them `foreman_<tool>`: each listed one is
// allowed by its exact name, after `"*": "deny"`, and no other tool of that server is.
import {
  isContextToolName,
  type ContextToolName,
} from "../../adapters/agent-runtime/kubernetes/task.ts";
import type { AgentRole } from "../../adapters/agent-runtime/runtime.ts";

export type PermissionAction = "allow" | "deny";
/** OpenCode's `permission` block: a tool's action, or per-pattern actions (bash). */
export type Permissions = Record<
  string,
  PermissionAction | Record<string, PermissionAction>
>;

/** The plain tools: Claude Code's name to OpenCode's permission key. */
const PLAIN: Readonly<Record<string, string>> = {
  Read: "read",
  // `edit` covers OpenCode's edit, write and apply_patch tools.
  Edit: "edit",
  Write: "edit",
  Glob: "glob",
  Grep: "grep",
};

const BASH = /^Bash\((.+)\)$/s;
/** The Designer's MagicPath MCP server (D-196). OpenCode names its tools `magicpath_<tool>`. */
export const MAGICPATH_TOOL = "mcp__magicpath";
export const MAGICPATH_PERMISSION = "magicpath_*";
/** The key of the run's context tools' MCP server in OpenCode's `mcp` block. */
export const CONTEXT_MCP_SERVER = "foreman";
/** OpenCode's name, and permission key, for one context tool: `foreman_<tool>`. */
export const contextToolPermission = (tool: ContextToolName): string =>
  `${CONTEXT_MCP_SERVER}_${tool}`;

export function openCodePermissions(
  role: AgentRole,
  allowedTools: readonly string[],
  contextTools: readonly ContextToolName[] = [],
): Permissions {
  if (allowedTools.length === 0)
    throw new Error(`a ${role} task needs its allowed tools`);
  const plain: Permissions = {};
  const bash: Record<string, PermissionAction> = {};
  let magicPath = false;
  allowedTools.forEach((tool, index) => {
    const position = `allowed tool ${index + 1}`;
    const key = PLAIN[tool];
    if (key !== undefined) {
      plain[key] = "allow";
      return;
    }
    const pattern = BASH.exec(tool)?.[1]?.trim();
    if (pattern !== undefined) {
      // A pattern of only wildcards would allow every command.
      if (/^[\s*?]*$/.test(pattern)) {
        throw new Error(`${position} would allow every shell command`);
      }
      bash[pattern] = "allow";
      return;
    }
    if (tool === "Bash") throw new Error(`${position} would allow every shell command`);
    if (tool === MAGICPATH_TOOL) {
      if (role !== "designer")
        throw new Error(`${position} is only for a Designer run`);
      magicPath = true;
      return;
    }
    throw new Error(`${position} has no OpenCode permission`);
  });
  const context: Permissions = {};
  contextTools.forEach((tool, index) => {
    if (!isContextToolName(tool)) {
      throw new Error(`context tool ${index + 1} is not a known tool`);
    }
    context[contextToolPermission(tool)] = "allow";
  });
  return {
    "*": "deny",
    ...plain,
    ...(Object.keys(bash).length > 0 ? { bash: { "*": "deny", ...bash } } : {}),
    ...(magicPath ? { [MAGICPATH_PERMISSION]: "allow" } : {}),
    ...context,
  };
}
