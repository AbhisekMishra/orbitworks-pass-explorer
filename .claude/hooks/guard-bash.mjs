// PreToolUse (Bash | PowerShell): blocks destructive or guardrail-bypassing shell commands.
import { block, readEvent } from './lib/io.mjs';
import { evaluateShellCommand } from './lib/policy.mjs';

const event = await readEvent();
const reason = evaluateShellCommand(event.tool_input?.command);
if (reason) block(`[guard-bash] Blocked: ${reason}`);
