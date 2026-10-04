import { RuleMatch, RuleMatchKind } from "view-ignored/patterns"
import { Target } from "view-ignored/targets"

import { printErr } from "./printErr.js"
import { nameFromTargetMaker, targetMakerFromName, TargetName } from "./targetName.js"

export function explain(match: RuleMatch, t: TargetName | (() => Target)): string {
	const targetName = typeof t === "string" ? t : nameFromTargetMaker(t)
	const targetMaker = typeof t === "string" ? targetMakerFromName(t) : t
	const target = targetMaker()
	const status = match.ignored ? "Ignored" : "Included"
	const potential =
		target.extractors.length === 0
			? "no potential sources"
			: `potential sources: ${target.extractors.map((e) => e.path).join(", ")}`
	const nos = "<no source path>"

	let reason = ""
	switch (match.kind) {
		case RuleMatchKind.external: {
			const pattern =
				("excludes" in match.rule && match.rule.excludes ? "!" : "") + String(match.pattern)
			const sourcePath =
				(match.source?.path ?? nos) +
				("range" in match.rule && match.rule.range ? `:${match.rule.range.join(":")}` : "")
			reason = `${status} by ${targetName} because ${pattern.startsWith("//") ? `it's ${pattern.slice(2)}` : `of '${pattern}' in ${sourcePath}`}`
			break
		}
		case RuleMatchKind.internal: {
			const pattern =
				("excludes" in match.rule && match.rule.excludes ? "!" : "") + String(match.pattern)
			reason = `${status} by ${targetName} because ${pattern.startsWith("//") ? `it's ${pattern.slice(2)}` : `of '${pattern}'`} (internal pattern source)`
			break
		}
		case RuleMatchKind.noMatch: {
			const sourcePath = match.source?.path ?? nos
			const action = (match.source?.inverted ?? true) ? "excludes" : "includes"
			reason = `${status} by ${targetName} because ${sourcePath} ${action} it (no matching patterns)`
			break
		}
		case RuleMatchKind.missingSource:
			reason = `${status} by ${targetName} because no sources were found; ${potential}`
			break
		case RuleMatchKind.invalidSource: {
			const sourcePath = match.source?.path ?? nos
			if ((match.error as any).code === "ENOENT") {
				reason = `${status} by ${targetName} because ${sourcePath} was not found`
				printErr(
					new Error(`Expected file in ${sourcePath}`, {
						cause: match.error!,
					}),
				)
				break
			}
			reason = `${status} by ${targetName} because ${sourcePath} has broken syntax`
			printErr(
				new Error(`Broken syntax in ${sourcePath}`, {
					cause: match.error!,
				}),
			)
			break
		}
		case RuleMatchKind.invalidInternal:
			reason = `${status} by ${targetName} because target has broken internal patterns`
			printErr(new Error("Broken internal patterns", { cause: match.error! }))
			break
		case RuleMatchKind.invalidExternal: {
			const sourcePath =
				(match.source?.path ?? nos) +
				("range" in match.rule && match.rule.range ? `:${match.rule.range.join(":")}` : "")
			reason = `${status} by ${targetName} because ${sourcePath} has broken patterns`
			printErr(
				new Error(`Broken patterns in ${sourcePath}`, {
					cause: match.error!,
				}),
			)
			break
		}
		case RuleMatchKind.none:
			reason = `${status} by ${targetName} because it is not scanned; ${potential}`
			printErr(new Error("Not scanned"))
			break
		default:
			return ""
	}
	return reason
}
