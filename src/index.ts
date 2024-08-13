import * as core from '@actions/core'
import * as github from '@actions/github'
import { Configuration, OpenAIApi } from 'openai'

interface FileDiff {
	filename: string
	patch: string
}

interface FileAnalysis {
	filename: string
	feedback: string
	patch: string
	hasCriticalFeedback: boolean
}

interface Config {
	contextLines: number
	openAIModel: string
}

const config: Config = {
	contextLines: 3,
	openAIModel: 'gpt-4o', // Use a valid model name
}

async function getChangedFiles(
	octokit: ReturnType<typeof github.getOctokit>,
	context: typeof github.context
): Promise<FileDiff[]> {
	try {
		console.log('Fetching changed files...')
		const { data: files } = await octokit.rest.pulls.listFiles({
			...context.repo,
			pull_number: context.payload.pull_request!.number,
		})
		console.log(`Found ${files.length} changed files`)
		return files.map((file) => ({
			filename: file.filename,
			patch: file.patch || '',
		}))
	} catch (error) {
		console.error('Error in getChangedFiles:', error)
		throw new Error(`Failed to get changed files: ${error}`)
	}
}

async function getFileContent(
	octokit: ReturnType<typeof github.getOctokit>,
	context: typeof github.context,
	filename: string
): Promise<string> {
	try {
		console.log(`Fetching content for file: ${filename}`)
		const { data } = await octokit.rest.repos.getContent({
			...context.repo,
			path: filename,
			ref: context.payload.pull_request!.head.sha,
		})
		if ('content' in data && typeof data.content === 'string') {
			console.log(`Successfully fetched content for ${filename}`)
			return Buffer.from(data.content, 'base64').toString('utf-8')
		}
		throw new Error(`Unable to get content for ${filename}`)
	} catch (error) {
		if (error instanceof Error && error.message.includes('too large')) {
			console.warn(`File ${filename} is too large to fetch content. Skipping.`)
			core.warning(`File ${filename} is too large to fetch content. Skipping.`)
			return ''
		}
		console.error(`Error in getFileContent for ${filename}:`, error)
		throw new Error(`Failed to get file content: ${error}`)
	}
}

function extractContext(
	fullContent: string,
	patch: string,
	contextLines: number = config.contextLines
): string {
	console.log('Extracting context...')
	const lines = fullContent.split('\n')
	const patchLines = patch.split('\n')
	let contextContent = ''
	let lineNumber = 0

	for (const patchLine of patchLines) {
		if (patchLine.startsWith('@@')) {
			const match = patchLine.match(/@@ -(\d+),\d+ \+\d+,\d+ @@/)
			if (match) {
				lineNumber = parseInt(match[1]) - 1
			}
		} else if (patchLine.startsWith('-')) {
			// Skip removed lines
			lineNumber++
		} else if (patchLine.startsWith('+')) {
			const start = Math.max(0, lineNumber - contextLines)
			const end = Math.min(lines.length, lineNumber + contextLines + 1)
			contextContent += lines.slice(start, end).join('\n') + '\n\n'
			lineNumber++
		} else {
			lineNumber++
		}
	}

	console.log('Context extraction complete')
	return contextContent.trim()
}

async function generatePRSummary(
	openai: OpenAIApi,
	files: FileDiff[]
): Promise<string> {
	console.log('Generating PR summary...')
	let allChanges = files
		.map((file) => `File: ${file.filename}\n\n${file.patch}\n\n`)
		.join('---\n\n')

	try {
		const response = await openai.createChatCompletion({
			model: config.openAIModel,
			messages: [
				{
					role: 'system',
					content:
						'You are a helpful code reviewer. Provide a concise summary of the overall changes in this pull request. Your output should be structured as bullet points',
				},
				{
					role: 'user',
					content: `Summarize the following changes in the pull request:\n\n${allChanges}`,
				},
			],
		})

		console.log('PR summary generated successfully')
		return response.data.choices[0].message?.content || ''
	} catch (error) {
		console.error('Error in generatePRSummary:', error)
		throw new Error(`Failed to generate PR summary: ${error}`)
	}
}

async function analyzeFileChanges(
	openai: OpenAIApi,
	filename: string,
	patch: string,
	context: string
): Promise<{ feedback: string; hasCriticalFeedback: boolean }> {
	try {
		console.log(`Analyzing changes for file: ${filename}`)
		const response = await openai.createChatCompletion({
			model: config.openAIModel,
			messages: [
				{
					role: 'system',
					content:
						"You are a helpful staff engineer who is reviewing code.\nProvide constructive feedback on the code changes. Each of the feedback should be numbered points. Each of the points should have a title called **Observation:** and **Actionable Feedback**.\nAn example is ```3. **Observation:** Potential Performance Issue\n**Actionable Feedback:** If `setPageTitle` involves any non-trivial computation, or if `useSidebarPageStore` has additional side effects, you may want to optimize the trigger. One way is by checking if the title is already 'Tasks' before calling `setPageTitle`.```\nFocus your feedback on the changed parts of the code (lines starting with '+' or '-'), but use the surrounding context to inform your analysis. At the end of your feedback, add a new line with just 'CRITICAL_FEEDBACK:' followed by 'true' if you have substantial or critical feedback, or 'false' if your feedback is minor or just positive.",
				},
				{
					role: 'user',
					content: `Review the following code changes for file ${filename}:\n\nChanged parts:\n${patch}\n\nBroader file context:\n${context}`,
				},
			],
		})

		const content = response.data.choices[0].message?.content || ''
		const [feedback, criticalIndicator] = content.split('CRITICAL_FEEDBACK:')
		const hasCriticalFeedback =
			criticalIndicator.trim().toLowerCase() === 'true'

		console.log(
			`Analysis complete for ${filename}. Critical feedback: ${hasCriticalFeedback}`
		)
		return { feedback: feedback.trim(), hasCriticalFeedback }
	} catch (error) {
		console.error(`Error in analyzeFileChanges for ${filename}:`, error)
		throw new Error(`Failed to analyze file changes: ${error}`)
	}
}

async function updatePRDescription(
	octokit: ReturnType<typeof github.getOctokit>,
	context: typeof github.context,
	summary: string
) {
	try {
		console.log('Updating PR description...')
		const currentBody = context.payload.pull_request!.body || ''
		const newSummary = `## GPT-4 Summary\n\n${summary}`
		const newBody = `${currentBody}\n\n${newSummary}`

		await octokit.rest.pulls.update({
			...context.repo,
			pull_number: context.payload.pull_request!.number,
			body: newBody,
		})
		console.log('PR description updated successfully')
	} catch (error) {
		console.error('Error in updatePRDescription:', error)
		throw new Error(`Failed to update PR description: ${error}`)
	}
}

async function addPRComment(
	octokit: ReturnType<typeof github.getOctokit>,
	context: typeof github.context,
	analyses: FileAnalysis[]
) {
	try {
		console.log('Adding PR comment...')
		const criticalAnalyses = analyses.filter(
			(analysis) => analysis.hasCriticalFeedback
		)

		if (criticalAnalyses.length === 0) {
			console.log('No critical feedback to add to the PR.')
			return
		}

		let feedbackContent = '## GPT-4 Feedback\n\n'

		for (const analysis of criticalAnalyses) {
			feedbackContent += `### ${analysis.filename}\n\n`
			feedbackContent += '```diff\n' + analysis.patch + '\n```\n\n'
			feedbackContent += `${analysis.feedback}\n\n`
		}

		console.log('Creating new feedback comment')
		await octokit.rest.issues.createComment({
			...context.repo,
			issue_number: context.payload.pull_request!.number,
			body: feedbackContent,
		})

		console.log('PR comment added successfully')
	} catch (error) {
		console.error('Error in addPRComment:', error)
		throw new Error(`Failed to add PR comment: ${error}`)
	}
}

async function run(): Promise<void> {
	try {
		console.log('Starting code review process...')
		const githubToken = core.getInput('GITHUB_TOKEN', { required: true })
		const openaiApiKey = core.getInput('OPENAI_API_KEY', { required: true })

		const octokit = github.getOctokit(githubToken)
		const openai = new OpenAIApi(new Configuration({ apiKey: openaiApiKey }))

		const changedFiles = await getChangedFiles(octokit, github.context)

		console.log('Analyzing changed files...')
		const [prSummary, fileAnalyses] = await Promise.all([
			generatePRSummary(openai, changedFiles),
			Promise.all(
				changedFiles.map(async (file) => {
					const fullContent = await getFileContent(
						octokit,
						github.context,
						file.filename
					)
					const contextContent = extractContext(fullContent, file.patch)
					const { feedback, hasCriticalFeedback } = await analyzeFileChanges(
						openai,
						file.filename,
						file.patch,
						contextContent
					)
					return {
						filename: file.filename,
						feedback,
						patch: file.patch,
						hasCriticalFeedback,
					}
				})
			),
		])

		console.log('Updating PR description and adding comments...')
		await Promise.all([
			updatePRDescription(octokit, github.context, prSummary),
			addPRComment(octokit, github.context, fileAnalyses),
		])

		console.log('Code review process completed successfully')
	} catch (error) {
		console.error('Error in run function:', error)
		if (error instanceof Error) {
			core.setFailed(error.message)
		} else {
			core.setFailed('An unknown error occurred')
		}
	}
}

run()
