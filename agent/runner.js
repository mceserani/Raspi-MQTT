import { spawn } from 'node:child_process';

// Built-in Claude Code tools the agent must never use: it works only through
// the MCP server. Unknown names are harmless, so the list errs on the long side.
export const BUILTIN_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'Skill', 'SlashCommand'];

export function buildClaudeArgs({ model, tools, maxTurns, mcpConfig, systemPrompt }) {
	return [
		'-p',
		'--model', model,
		'--output-format', 'json',
		'--max-turns', String(maxTurns),
		'--mcp-config', mcpConfig,
		'--strict-mcp-config',
		'--allowedTools', tools.map((tool) => `mcp__raspi__${tool}`).join(','),
		'--disallowedTools', BUILTIN_TOOLS.join(','),
		'--append-system-prompt', systemPrompt
	];
}

// Output of "claude -p --output-format json": one JSON object with the result
export function parseClaudeOutput(stdout) {
	const text = stdout.trim();
	const start = text.lastIndexOf('\n{');
	const json = JSON.parse(start >= 0 ? text.slice(start + 1) : text);
	return {
		ok: json.is_error === false && json.subtype === 'success',
		subtype: json.subtype,
		result: typeof json.result === 'string' ? json.result : '',
		turns: json.num_turns ?? null,
		durationS: json.duration_ms ? Math.round(json.duration_ms / 1000) : null,
		costUsd: json.total_cost_usd ?? null
	};
}

// Runs one job; the prompt goes on stdin (never mistaken for an option).
// Resolves { ok, result, ... } and never rejects.
export function runClaude({ claudeBin, cwd, args, prompt, timeoutSeconds, env = process.env }) {
	return new Promise((resolve) => {
		const child = spawn(claudeBin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), 5000).unref();
		}, timeoutSeconds * 1000);

		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('error', (error) => {
			clearTimeout(timer);
			resolve({ ok: false, error: `avvio di Claude non riuscito: ${error.message}` });
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (timedOut) {
				resolve({ ok: false, error: `interrotto dopo ${timeoutSeconds} s` });
				return;
			}
			try {
				const parsed = parseClaudeOutput(stdout);
				resolve(parsed.ok ? parsed : { ...parsed, error: `esecuzione terminata con ${parsed.subtype}` });
			} catch {
				resolve({ ok: false, error: `uscita ${code}: ${(stderr || stdout).trim().slice(-500) || 'nessun output'}` });
			}
		});

		child.stdin.end(prompt);
	});
}
