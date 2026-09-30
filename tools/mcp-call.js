// Calls the MCP server tools without Claude (0 tokens): for testing on the PC
// with the simulator and on the Pi as the raspi-agent user.
//
//   node --env-file=<env> tools/mcp-call.js                 list the tools
//   node --env-file=<env> tools/mcp-call.js <tool> ['{json}'] call a tool
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const [tool, rawArgs] = process.argv.slice(2);

let args = {};
if (rawArgs) {
	try {
		args = JSON.parse(rawArgs);
	} catch (error) {
		console.error(`Argomenti JSON non validi: ${error.message}`);
		process.exit(1);
	}
}

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [path.join(here, '..', 'mcp', 'server.js')],
	env: process.env,
	stderr: 'inherit'
});
const client = new Client({ name: 'mcp-call', version: '1.0.0' });
await client.connect(transport);

try {
	if (!tool) {
		const { tools } = await client.listTools();
		for (const t of tools) {
			const params = Object.keys(t.inputSchema?.properties ?? {});
			console.log(`${t.name}(${params.join(', ')})\n    ${t.description}\n`);
		}
	} else {
		const result = await client.callTool({ name: tool, arguments: args });
		const text = result.content?.map((c) => c.text).join('\n') ?? '';
		let output = text;
		try {
			output = JSON.stringify(JSON.parse(text), null, 2);
		} catch {
			// plain text (errors)
		}
		console.log(result.isError ? `ERRORE: ${output}` : output);
		process.exitCode = result.isError ? 2 : 0;
	}
} finally {
	await client.close();
}
