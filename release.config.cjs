const releaseType = process.env.RELEASE_TYPE

const commitAnalyzerPlugin =
	releaseType && releaseType !== "auto"
		? [
				"@semantic-release/commit-analyzer",
				{
					preset: "conventionalcommits",
					releaseRules: [{ release: releaseType }],
				},
			]
		: [
				"@semantic-release/commit-analyzer",
				{
					preset: "conventionalcommits",
				},
			]

module.exports = {
	branches: ["main", "master"],
	plugins: [
		commitAnalyzerPlugin,
		[
			"@semantic-release/release-notes-generator",
			{
				preset: "conventionalcommits",
			},
		],
		"@semantic-release/changelog",
		[
			"@semantic-release/npm",
			{
				npmPublish: false,
			},
		],
		[
			"@semantic-release/exec",
			{
				prepareCmd: "bun run vsix",
			},
		],
		[
			"@semantic-release/git",
			{
				assets: ["package.json", "CHANGELOG.md"],
				message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		[
			"@semantic-release/github",
			{
				assets: [
					{
						path: "*.vsix",
						label: "VS Code Extension (.vsix)",
					},
				],
			},
		],
	],
}
