import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

// npm treats an existing install of the same version as current, so remove it to pick up changes.
for (const application of ['fixture', 'second-app']) {
	const directory = join(import.meta.dirname, application);
	rmSync(join(directory, 'node_modules'), { recursive: true, force: true });
	execFileSync('npm', ['install'], { cwd: directory, stdio: 'inherit' });
}
