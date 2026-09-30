import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatLocal } from './format.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// The agent's memory between runs: one Markdown file per note in notesDir.
export class NotesStore {
	constructor(dir, { maxBytes, now = () => Date.now() }) {
		this.dir = dir;
		this.maxBytes = maxBytes;
		this.now = now;
	}

	file(name) {
		if (!NAME.test(name)) {
			throw new Error('nome nota non valido: minuscole, cifre, "-" e "_", al massimo 41 caratteri');
		}
		return path.join(this.dir, `${name}.md`);
	}

	async list() {
		await mkdir(this.dir, { recursive: true });
		const notes = [];
		for (const entry of await readdir(this.dir)) {
			if (!entry.endsWith('.md')) continue;
			const info = await stat(path.join(this.dir, entry));
			notes.push({ name: entry.slice(0, -3), bytes: info.size, modified: formatLocal(info.mtime) });
		}
		return notes.sort((a, b) => a.name.localeCompare(b.name));
	}

	async read(name) {
		try {
			return await readFile(this.file(name), 'utf8');
		} catch (error) {
			if (error.code === 'ENOENT') return null;
			throw error;
		}
	}

	// mode "append" adds a dated entry; "replace" rewrites the note
	async write(name, content, mode) {
		const file = this.file(name);
		const previous = mode === 'append' ? (await this.read(name)) ?? '' : '';
		const entry = mode === 'append' ? `\n## ${formatLocal(this.now(), { seconds: false })}\n\n${content.trim()}\n` : `${content.trim()}\n`;
		const next = previous + entry;
		const bytes = Buffer.byteLength(next, 'utf8');
		if (bytes > this.maxBytes) {
			throw new Error(`la nota "${name}" supererebbe ${this.maxBytes} byte (${bytes}): riassumila e riscrivila con mode "replace"`);
		}
		await mkdir(this.dir, { recursive: true });
		await writeFile(file, next, 'utf8');
		return { name, bytes };
	}
}
