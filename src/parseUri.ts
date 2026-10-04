import { sep } from "node:path"
import * as vscode from "vscode"

import { output } from "./output.js"

export function parseUri(uri: vscode.Uri): { entry: string; cwd: string } | void {
	if (uri.scheme !== "file") {
		if (["vscode-agent-host"].includes(uri.scheme)) return
		output.warn("Ignoring '" + uri.scheme + "' uri scheme for ", uri)
		return
	}
	const fsPath = uri.fsPath.replace(/\/\w:/, "")
	const folder =
		vscode.workspace.workspaceFolders?.find((f) => fsPath.startsWith(f.uri.fsPath))?.uri.fsPath ||
		""
	if (!folder) {
		const msg = "Cannot parse URI: " + uri.toString()
		output.error(msg)
		vscode.window.showErrorMessage(msg)
	}
	if (folder === fsPath) {
		const entry = "."
		const cwd = folder.replace(/^\\|^\//, "").replaceAll(/\\/g, "/")
		return { entry, cwd }
	}
	const cwd = folder.replace(/^\\|^\//, "").replaceAll(/\\/g, "/")
	const entry = fsPath
		.replace(folder, "")
		.replace(/^\\|^\//, "")
		.replaceAll(/\\/g, "/")
	return { entry, cwd }
}

export function pathToUri(cwd: string, path: string): vscode.Uri {
	return vscode.Uri.file(cwd + "/" + path.replace("/", sep))
}
