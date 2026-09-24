// PreToolUse (Edit | Write | MultiEdit | NotebookEdit): protects immutable/secret/harness files and
// refuses content that looks like a credential.
import { PROJECT_ROOT, block, readEvent } from './lib/io.mjs';
import { evaluateContent, evaluateFileTarget } from './lib/policy.mjs';

const event = await readEvent();
const input = event.tool_input ?? {};
const filePath = input.file_path ?? input.notebook_path;

const targetReason = filePath ? evaluateFileTarget(filePath, PROJECT_ROOT) : null;
if (targetReason) block(`[guard-files] Blocked: ${targetReason}`);

const written = [
  input.content,
  input.new_string,
  input.new_source,
  ...(input.edits ?? []).map((e) => e.new_string),
]
  .filter(Boolean)
  .join('\n');
const contentReason = evaluateContent(written);
if (contentReason) block(`[guard-files] Blocked: ${contentReason}`);
