import ms from "ms"
import * as fs from "node:fs"
import * as vign from "view-ignored"
import {
	MatcherContext,
	matcherContextAddPath,
	matcherContextRemovePath,
	RuleMatch,
} from "view-ignored/patterns"
import { Target } from "view-ignored/targets"
import * as vscode from "vscode"

import { getTarget, setInvert, setScanning, setTarget } from "./context.js"
import { explain } from "./explain.js"
import { output } from "./output.js"
import { parseUri, pathToUri } from "./parseUri.js"
import { printErr } from "./printErr.js"
import { Semaphore } from "./semaphore.js"
import { nameFromTargetMaker, targetMakerFromName } from "./targetName.js"

export type DecorationKind = "ignored" | "included" | "unknown"

export class DecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
	private subscriptions: vscode.Disposable[] = []
	private mutexWorspaceFolderChange = new Semaphore(1)
	private mutexWatcher = new Semaphore(1)
	private readonly onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()
	readonly onDidChangeFileDecorations = this.onDidChange.event.bind(this.onDidChange)

	private decorations = new Map<string, DecorationKind>()

	private contexts: Map<string, MatcherContext> = new Map()

	private aborter = new AbortController()
	private options: Required<Omit<vign.ScanOptions, "cwd">>

	private watchQueue: {
		eventName: string
		uri: vscode.Uri
		cb: (ctx: MatcherContext, f: { cwd: string; entry: string }) => Promise<void>
	}[] = []
	private watchDebounceTimer: NodeJS.Timeout | null = null

	constructor() {
		this.options = {
			target: null as unknown as Target,
			skipDepth: true,
			invert: null as unknown as boolean | 2,
			depth: Infinity,
			fs,
			signal: null,
			dirs: false,
			within: ".",
		}
	}

	public isTemporary = false

	async init(
		options: Partial<Omit<vign.ScanOptions, "cwd" | "target">> & { target: () => Target },
	): Promise<void> {
		await this.deinit()

		const start = Date.now()
		output.info("Initializing decoration provider...")
		await this.scan(options)

		output.info("Adding workspace folders listener...")
		const l = vscode.workspace.onDidChangeWorkspaceFolders(async () => {
			output.info("Locked workspace folders listener mutexWorspaceFolderChange")
			using folders = this.mutexWorspaceFolderChange.tryAcquire()
			using stack = new DisposableStack();
			stack.defer(() => output.info("Unlocked workspace folders listener mutexWorspaceFolderChange"))
			if (!folders) return
			output.info("Locked workspace folders listener mutexWatcher")
			stack.use(this.mutexWatcher.tryAcquire())
			stack.defer(() => output.info("Unlocked workspace folders listener mutexWatcher"))
			await this.scan(options)
		})

		this.aborter.signal.addEventListener(
			"abort",
			() => {
				output.info("Removing workspace folders listener...")
				l.dispose()
			},
			{ once: true },
		)

		this.watch(this.aborter.signal)
		output.info("Initialized decoration provider in " + ms(Date.now() - start))
	}

	private async scan(
		options: Partial<Omit<vign.ScanOptions, "cwd" | "target">> & { target: () => Target },
	): Promise<void> {
		setScanning(true)
		const start = Date.now()
		output.info("Preparing to scan...")
		using stack = new DisposableStack();
		stack.defer(() => {
			setScanning(false)
			output.info("Constructed in " + ms(Date.now() - start))
		})
		const targetMaker = options.target
		options.invert ??= false
		assignOpt(this.options, options)
		this.options.target = targetMaker()
		this.options.invert = options.invert

		this.decorations.clear()
		this.contexts.clear()
		this.onDidChange.fire(undefined)

		if (!vscode.workspace.workspaceFolders) return
		let updated = false
		for (const directory of vscode.workspace.workspaceFolders) {
			const cwd = directory.uri.fsPath.replaceAll("\\", "/")
			let start = Date.now()
			try {
				var ctx = await vign.scan({ ...this.options, cwd })
				if (!updated) {
					updated = true
					setTarget(nameFromTargetMaker(targetMaker))
					setInvert(options.invert)
				}
			} catch (cause) {
				const message = "Scanned with exception in " + ms(Date.now() - start)
				printErr(new Error(message, { cause }))
				vscode.window.showErrorMessage(message, "Show output").then((choice) => {
					if (choice === "Show output") output.show()
				})
				continue
			}
			output.info("Scanned " + ctx.paths.size + " paths in " + ms(Date.now() - start))
			this.isTemporary = false
			this.contexts.set(cwd, ctx)
			for (const [file, match] of ctx.paths) {
				if (options.signal?.aborted) return
				const uri = pathToUri(cwd, file)
				this.add(uri, match)
			}
			output.info("Normalized in " + ms(Date.now() - start))
		}
	}

	add(uri: vscode.Uri, match: RuleMatch): void {
		const f = parseUri(uri)
		if (!f) return
		const decoration = match.ignored ? "ignored" : "included"
		this.decorations.set(uri.fsPath, decoration)
		setImmediate(() => this.onDidChange.fire(uri))
	}

	del(uri: vscode.Uri): void {
		this.decorations.delete(uri.fsPath)
		setImmediate(() => this.onDidChange.fire(uri))
	}

	private async watchPatch(
		eventName: string,
		f: { cwd: string; entry: string },
		cb: (ctx: MatcherContext, f: { cwd: string; entry: string }) => Promise<void>,
	): Promise<void> {
		output.info("Got '" + eventName + "' event")
		const ctx = this.contexts.get(f.cwd)
		if (!ctx) return
		const before = new Set(ctx.paths.keys())
		await cb(ctx, f)
		const after = new Set(ctx.paths.keys())
		const added = Array.from(after.difference(before)),
			removed = Array.from(before.difference(after))
		if (added.length + removed.length > 0) output.info("File " + eventName + ":", f.entry)
		if (added.length > 0) output.info("Added " + f.entry + ":", added)
		const signal = this.options.signal
		for (const element of added) {
			if (signal?.aborted) return
			const uri = pathToUri(f.cwd, element)
			this.add(uri, ctx.paths.get(f.entry)!)
		}
		if (removed.length > 0) output.info("Deleted " + f.entry + ":", removed)
		for (const element of removed) {
			if (signal?.aborted) return
			const uri = pathToUri(f.cwd, element)
			this.del(uri)
		}
	}

	private watch(signal: AbortSignal): void {
		const start = Date.now()
		const watcher = vscode.workspace.createFileSystemWatcher("**/*", false, false, false)
		output.info("Created watcher in " + ms(Date.now() - start))

		const queueEvent = (
			eventName: string,
			cb: (ctx: MatcherContext, f: { cwd: string; entry: string }) => Promise<void>,
		) => {
			return (uri: vscode.Uri) => {
				if (signal.aborted) return
				this.watchQueue.push({ eventName, uri, cb })

				if (this.watchDebounceTimer) {
					clearTimeout(this.watchDebounceTimer)
				}

				this.watchDebounceTimer = setTimeout(() => {
					this.flushWatchQueue()
				}, 50)
			}
		}

		const watcherListeners = [
			watcher.onDidChange(
				queueEvent("changed", async (ctx, f) => {
					const opts: Required<vign.ScanOptions> = { cwd: f.cwd, ...this.options, signal }
					await matcherContextRemovePath(ctx, opts, f.entry)
					await matcherContextAddPath(ctx, opts, f.entry)
				}),
			),
			watcher.onDidCreate(
				queueEvent("created", async (ctx, f) => {
					const opts: Required<vign.ScanOptions> = { cwd: f.cwd, ...this.options, signal }
					await matcherContextAddPath(ctx, opts, f.entry)
				}),
			),
			watcher.onDidDelete(
				queueEvent("deleted", async (ctx, f) => {
					const opts: Required<vign.ScanOptions> = { cwd: f.cwd, ...this.options, signal }
					await matcherContextRemovePath(ctx, opts, f.entry)
				}),
			),
		]

		output.info(
			"Started " + watcherListeners.length + " watcher listeners in " + ms(Date.now() - start),
		)

		const abort = () => {
			output.info("Disposing watcher and listeners...")
			const start = Date.now()
			if (this.watchDebounceTimer) {
				clearTimeout(this.watchDebounceTimer)
				this.watchDebounceTimer = null
			}
			this.watchQueue = []
			watcherListeners.forEach((l) => l.dispose())
			watcher.dispose()
			setScanning(false)
			output.info("Disposed watcher in " + ms(Date.now() - start))
		}

		output.info("Watcher will be disposed when signal is aborted")
		signal.addEventListener("abort", abort, { once: true })
	}

	private async flushWatchQueue(): Promise<void> {
		if (this.watchQueue.length === 0 || this.aborter.signal.aborted) return

		const batch = [...this.watchQueue]
		this.watchQueue = []

		const start = Date.now()
		output.info(`Locked/Waiting processing batch of ${batch.length} file system events`)

		using stack = new DisposableStack()
		stack.use(await this.mutexWatcher.acquire())
		stack.defer(() => output.info(`Unlocked/Updated batch of ${batch.length} events in ` + ms(Date.now() - start)))

		for (const task of batch) {
			if (this.aborter.signal.aborted) break
			const f = parseUri(task.uri)
			if (!f) continue
			await this.watchPatch(task.eventName, f, task.cb)
		}
	}

	async clear(save = true): Promise<void> {
		decorationProvider.isTemporary = !save
		if (save) {
			setTarget("None")
			setInvert(false)
			this.options.target = null as unknown as Target
			this.options.invert = false
		}
		if (this.decorations.size === 0) return
		const start = Date.now()
		output.info("Clearing...")
		this.decorations.clear()
		this.contexts.clear()
		this.onDidChange.fire(undefined)
		output.info("Cleared in " + ms(Date.now() - start))
	}

	provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
		const state = this.decorations.get(uri.fsPath)
		if (!state) return
		const parsed = parseUri(uri)
		if (!parsed) return
		const ctx = this.contexts.get(parsed.cwd)
		if (!ctx) return
		const match = ctx.paths.get(parsed.entry)
		const tooltip = match
			? explain(match, targetMakerFromName(getTarget(true)))
			: "Internal error: could not find '" + parsed.entry + "'"
		const propagate = true
		let badge: string
		switch (state) {
			case "ignored":
				badge = "-"
				return { badge, tooltip, propagate }
			case "included":
				badge = "+"
				return { badge, tooltip, propagate }
		}
	}

	async deinit(): Promise<void> {
		if (typeof decorationProvider === "undefined") return
		const start = Date.now()
		output.info("Deinitializing...")
		if (this.watchDebounceTimer) {
			clearTimeout(this.watchDebounceTimer)
			this.watchDebounceTimer = null
		}
		this.watchQueue = []
		using stack = new DisposableStack()
		stack.use(await this.mutexWatcher.acquire())
		if (!this.aborter.signal.aborted) this.aborter.abort()

		this.aborter = new AbortController()
		output.info("Deinitialized in " + ms(Date.now() - start))
	}

	dispose() {
		const start = Date.now()
		output.info("Disposing...")
		if (this.watchDebounceTimer) {
			clearTimeout(this.watchDebounceTimer)
			this.watchDebounceTimer = null
		}
		this.watchQueue = []
		if (!this.aborter.signal.aborted) this.aborter.abort()
		for (const sub of this.subscriptions) sub.dispose()
		this.clear()
		this.onDidChange.dispose()
		output.info("Disposed in " + ms(Date.now() - start))
	}
}

export const decorationProvider = new DecorationProvider()

function assignOpt(target: any, ...sources: any[]) {
	for (const src of sources) {
		if (!src) continue
		for (const key in src) {
			if (!Object.hasOwn(src, key) || src[key] === undefined) continue
			target[key] = src[key]
		}
	}
	return target
}
