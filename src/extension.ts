// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Environment, PythonExtension } from '@vscode/python-extension';
import * as fs from 'fs';
import CryptoJS from 'crypto-js';
import * as path from 'path';
import util from 'node:util';


const execFile = util.promisify(require('node:child_process').execFile);

export function showNotification(message: string, duration: number) {
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

interface PDMContext {
	readonly logger: vscode.LogOutputChannel;
	readonly api: PythonExtension;
};

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

async function execShell(cmd: string, args: string[], cwd: string | undefined = undefined): Promise<string> {
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

	export const update_interpreter = async (c: PDMContext, pdm_python_file: vscode.Uri) => {
		const ws = vscode.workspace.getWorkspaceFolder(pdm_python_file);
		if (!ws) {
			c.logger.error('No workspace folder');
			return;
		}
		c.logger.info('Workspace folder: ' + ws.uri.fsPath);

		const python_bin_path = await PDM.get_active_python_bin(ws.uri);
		c.logger.info('Python path: ' + python_bin_path);

		const prompt = PDM.get_active_name(ws.uri, python_bin_path);



		await c.api.environments.updateActiveEnvironmentPath(python_bin_path.fsPath, ws);



		showNotification('Updated python interpreter in ' + ws.name + ' to ' + await prompt, 5000);
	};
}


// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	const c: PDMContext = {
		logger: vscode.window.createOutputChannel('PDM Interpreter', { log: true }),
		api: await PythonExtension.api()
	};
	await c.api.ready;
	c.logger.info('Python Extension API ready');



	const watcher = vscode.workspace.createFileSystemWatcher('**/.pdm-python').onDidChange(async (pdm_python_file) => {
		c.logger.appendLine('File changed: ' + pdm_python_file.fsPath);
		await Python.update_interpreter(c, pdm_python_file);
	});
	context.subscriptions.push(watcher);

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
			const result = await PDM.exec(["use", "--venv", selected_venv], ws_folder.uri);
			console.log(result);
		} catch (e: any) {
			vscode.window.showErrorMessage(e.message);
			return;
		}


	});
	context.subscriptions.push(select_interpreter);
}

// This method is called when your extension is deactivated
export async function deactivate(): Promise<void> {

};
