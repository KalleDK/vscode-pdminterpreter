// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { PythonExtension } from '@vscode/python-extension';
import * as fs from 'fs';
import CryptoJS from 'crypto-js';
import * as path from 'path';
import util from 'node:util';
import { execFile as _execFile } from 'node:child_process';


const execFile = util.promisify(_execFile);


class Watcher {
	readonly _watchers: Map<string, vscode.FileSystemWatcher>;
	readonly _ctx: PDMContext;

	constructor(ctx: PDMContext) {
		this._watchers = new Map<string, vscode.FileSystemWatcher>();
		this._ctx = ctx;
	}

	async enable(ws: vscode.WorkspaceFolder) {
		this._ctx.logger.info('Enabling watcher for ' + ws.name);
		if (this._watchers.has(ws.uri.fsPath)) {
			this._ctx.logger.error('Watcher already enabled for ' + ws.name);
			return;
		}
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ws, '.pdm-python'));
		watcher.onDidChange(async () => {
			this._ctx.logger.info('File changed: ' + ws.name);
			await Python.update_pdm_interpreter(this._ctx, ws.uri);
		});
		watcher.onDidCreate(async () => {
			this._ctx.logger.info('File created: ' + ws.name);
			await Python.update_pdm_interpreter(this._ctx, ws.uri);
		});

		await Python.update_pdm_interpreter(this._ctx, ws.uri);

		this._watchers.set(ws.uri.fsPath, watcher);
	}

	disable(ws: vscode.WorkspaceFolder) {
		this._ctx.logger.info('Disabling watcher for ' + ws.name);
		const watcher = this._watchers.get(ws.uri.fsPath);
		if (watcher) {
			this._watchers.delete(ws.uri.fsPath);
			watcher.dispose();
		}
	}

	dispose() {
		this._watchers.forEach((watcher) => watcher.dispose());
		this._watchers.clear();
	}
};

interface PDMContext {
	readonly logger: vscode.LogOutputChannel;
	readonly api: PythonExtension;
	dispose(): void;
};

function showNotification(message: string, duration: number) {
	vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification },
		async (progress) => {
			const steps = 100;
			const delay = duration / steps;

			for (let i = 0; i <= steps; i++) {
				await new Promise<void>((resolve) => {
					setTimeout(() => {
						progress.report({ increment: 1, message: message });
						resolve();
					}, delay);
				});
			}
		}
	);
}

async function select_workspace() {
	const ws_folders = vscode.workspace.workspaceFolders;
	if (!ws_folders) {
		throw new Error('No workspace folder');
	}
	const ws_folder = (ws_folders.length > 1) ? await vscode.window.showWorkspaceFolderPick() : ws_folders[0];

	if (!ws_folder) {
		throw new Error('No workspace folder picked');
	}
	return ws_folder;
}

async function execShell(cmd: string, args: string[], cwd: string | undefined = undefined) {
	const { stdout } = await execFile(cmd, args, { cwd: cwd });
	return stdout;
}

namespace PDM {
	function as_posix(ws_uri: vscode.Uri) {
		const ws_path = ws_uri.path;

		if ((ws_path.length < 3) || (ws_path[0] !== '/') || (ws_path[2] !== ':')) {
			return ws_path;
		}

		// PDM expects a posix path and the drive letter should be capitalized
		// or else the hash will be different
		// c:/flaf -> C:/flaf 
		return ws_path[1].toUpperCase() + ws_path.slice(2);
	};

	export const exec = (args: string[], ws: vscode.Uri | undefined = undefined) => execShell("pdm", args, (ws !== undefined) ? as_posix(ws) : undefined);

	const get_venv_root = async () => exec(["config", "venv.location"]).then((v) => v.trimEnd().trimStart());

	const get_hash = (p: vscode.Uri) => CryptoJS.MD5(as_posix(p)).toString(CryptoJS.enc.Base64url).slice(0, 8);

	const get_hashed_prefix = (p: vscode.Uri) => path.basename(p.fsPath) + '-' + get_hash(p) + '-';

	export async function get_active_name(ws: vscode.Uri, python_binary: vscode.Uri | undefined = undefined) {
		if (python_binary === undefined) {
			python_binary = await get_active_python_bin(ws);
		}
		const venv_path = vscode.Uri.joinPath(python_binary, '..', '..');
		const venv_hashed_name = path.basename(venv_path.fsPath);
		const hashed_prefix = get_hashed_prefix(ws);
		if (!venv_hashed_name.startsWith(hashed_prefix)) {
			return python_binary.fsPath;
		}
		return venv_hashed_name.slice(hashed_prefix.length);
	}

	export async function get_venvs(ws: vscode.Uri) {
		const venv_root_loc = await get_venv_root();
		const hashed_prefix = get_hashed_prefix(ws);
		const venvs = await fs.promises.readdir(venv_root_loc)
			.then((files) => files.filter((file) => path.basename(file).startsWith(hashed_prefix)))
			.then((files) => Object.fromEntries(files.map((file) => [path.basename(file).slice(hashed_prefix.length), file])));
		return venvs;
	}

	export async function get_active_python_bin(ws: vscode.Uri) {
		const python_bin_path = await fs.promises.readFile(vscode.Uri.joinPath(ws, ".pdm-python").fsPath, 'utf8')
			.then((value) => value.trimStart().trimEnd());
		return vscode.Uri.file(python_bin_path);
	}

	export async function get_prompt_of_venv(python_binary: vscode.Uri) {
		const pyenv = vscode.Uri.joinPath(python_binary, '..', '..', 'pyvenv.cfg');
		const prompt = fs.promises.readFile(pyenv.fsPath, 'utf8')
			.then((value) => value.split('\n'))
			.then((lines) => lines.find((line) => line.startsWith('prompt')))
			.then((line) => line?.split("=")[1].trimStart().trimEnd())
			.then((prompt) => prompt || python_binary.fsPath);
		return prompt;
	}
}

namespace Python {

	export const update_interpreter = async (c: PDMContext, ws: vscode.WorkspaceFolder) => {
		const python_bin_path = await PDM.get_active_python_bin(ws.uri);
		c.logger.info('Python path: ' + python_bin_path);

		const prompt = PDM.get_active_name(ws.uri, python_bin_path);

		const active_env = c.api.environments.getActiveEnvironmentPath(ws);
		if (active_env.path === python_bin_path.fsPath) {
			return;
		}

		await c.api.environments.updateActiveEnvironmentPath(python_bin_path.fsPath, ws);
		showNotification('Updated python interpreter in ' + ws.name + ' to ' + await prompt, 5000);
	};

	export const update_pdm_interpreter = async (c: PDMContext, pdm_python_file: vscode.Uri) => {
		const ws = vscode.workspace.getWorkspaceFolder(pdm_python_file);
		if (!ws) {
			c.logger.error('No workspace folder');
			return;
		}
		c.logger.info('Workspace folder: ' + ws.uri.fsPath);

		await update_interpreter(c, ws);
	};
}


function get_config(scope: vscode.ConfigurationScope | undefined = undefined) {
	const conf = vscode.workspace.getConfiguration('pdminterpreter', scope);
	return {
		autoChange: conf.get<boolean>('autoChange', false),
	};
}

async function create_ctx(): Promise<PDMContext> {
	const logger = vscode.window.createOutputChannel('PDM Interpreter', { log: true });
	const api = await PythonExtension.api();
	await api.ready;

	return {
		logger: logger,
		api: api,
		dispose: () => { logger.dispose(); }
	};

}

function create_watchers(ctx: PDMContext) {
	const watchers = new Watcher(ctx);
	vscode.workspace.workspaceFolders?.forEach(async (ws) => {
		const conf = get_config(ws);
		if (conf.autoChange) {
			await watchers.enable(ws);
		}
	});
	return watchers;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	const ctx = await create_ctx();
	context.subscriptions.push(ctx);

	const watchers = create_watchers(ctx);
	context.subscriptions.push(watchers);

	const conf_watcher = vscode.workspace.onDidChangeConfiguration((e) => {
		vscode.workspace.workspaceFolders?.forEach(async (ws) => {
			if (e.affectsConfiguration('pdminterpreter.autoChange', ws)) {
				const conf = get_config(ws);
				if (conf.autoChange) {
					await watchers.enable(ws);
				}
				else {
					watchers.disable(ws);
				}
			}
		});
	});
	context.subscriptions.push(conf_watcher);

	const ws_watcher = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
		e.removed.forEach((ws) => {
			ctx.logger.info("Removed: " + ws.name);
			watchers.disable(ws);
		});
		e.added.forEach(async (ws) => {
			ctx.logger.info("Added: " + ws.name);
			const conf = get_config(ws);
			if (conf.autoChange) {
				await watchers.enable(ws);
			}
		});
	});
	context.subscriptions.push(ws_watcher);


	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const select_interpreter = vscode.commands.registerCommand('pdminterpreter.select', async () => {
		try {
			const ws_folder = await select_workspace();
			const venvs = await PDM.get_venvs(ws_folder.uri);
			const venv_names = Object.keys(venvs);
			const selected_venv = await vscode.window.showQuickPick(venv_names);
			if (!selected_venv) {
				return;
			}
			await PDM.exec(["use", "--venv", selected_venv], ws_folder.uri);
		} catch (e: any) {
			vscode.window.showErrorMessage(e.message);
			return;
		}


	});
	context.subscriptions.push(select_interpreter);

	const update_interpreter = vscode.commands.registerCommand('pdminterpreter.update', async () => {
		try {
			const ws_folder = await select_workspace();
			Python.update_interpreter(ctx, ws_folder);
		} catch (e: any) {
			vscode.window.showErrorMessage(e.message);
			return;
		}


	});
	context.subscriptions.push(update_interpreter);

	ctx.logger.info('Python Extension API ready');
}

// This method is called when your extension is deactivated
export function deactivate(): void { };
