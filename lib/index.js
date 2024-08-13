"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const openai_1 = require("openai");
const config = {
    contextLines: 3,
    openAIModel: 'gpt-4o', // Use a valid model name
};
function getChangedFiles(octokit, context) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            core.info('Fetching changed files...');
            const { data: files } = yield octokit.rest.pulls.listFiles(Object.assign(Object.assign({}, context.repo), { pull_number: context.payload.pull_request.number }));
            core.info(`Found ${files.length} changed files`);
            return files.map((file) => ({
                filename: file.filename,
                patch: file.patch || '',
            }));
        }
        catch (error) {
            core.error(`Error in getChangedFiles: ${error}`);
            throw new Error(`Failed to get changed files: ${error}`);
        }
    });
}
function getFileContent(octokit, context, filename) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            core.info(`Fetching content for file: ${filename}`);
            const { data } = yield octokit.rest.repos.getContent(Object.assign(Object.assign({}, context.repo), { path: filename, ref: context.payload.pull_request.head.sha }));
            if ('content' in data && typeof data.content === 'string') {
                core.info(`Successfully fetched content for ${filename}`);
                return Buffer.from(data.content, 'base64').toString('utf-8');
            }
            throw new Error(`Unable to get content for ${filename}`);
        }
        catch (error) {
            if (error instanceof Error && error.message.includes('too large')) {
                core.warning(`File ${filename} is too large to fetch content. Skipping.`);
                return '';
            }
            core.error(`Error in getFileContent for ${filename}: ${error}`);
            throw new Error(`Failed to get file content: ${error}`);
        }
    });
}
function extractContext(fullContent, patch, contextLines = config.contextLines) {
    core.info('Extracting context...');
    const lines = fullContent.split('\n');
    const patchLines = patch.split('\n');
    let contextContent = '';
    let lineNumber = 0;
    for (const patchLine of patchLines) {
        if (patchLine.startsWith('@@')) {
            const match = patchLine.match(/@@ -(\d+),\d+ \+\d+,\d+ @@/);
            if (match) {
                lineNumber = parseInt(match[1]) - 1;
            }
        }
        else if (patchLine.startsWith('-')) {
            // Skip removed lines
            lineNumber++;
        }
        else if (patchLine.startsWith('+')) {
            const start = Math.max(0, lineNumber - contextLines);
            const end = Math.min(lines.length, lineNumber + contextLines + 1);
            contextContent += lines.slice(start, end).join('\n') + '\n\n';
            lineNumber++;
        }
        else {
            lineNumber++;
        }
    }
    core.info('Context extraction complete');
    return contextContent.trim();
}
function generatePRSummary(openai, files) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        core.info('Generating PR summary...');
        let allChanges = files
            .map((file) => `File: ${file.filename}\n\n${file.patch}\n\n`)
            .join('---\n\n');
        try {
            const response = yield openai.createChatCompletion({
                model: config.openAIModel,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a helpful code reviewer. Provide a concise summary of the overall changes in this pull request. Your output should be structured as bullet points',
                    },
                    {
                        role: 'user',
                        content: `Summarize the following changes in the pull request:\n\n${allChanges}`,
                    },
                ],
            });
            core.info('PR summary generated successfully');
            return ((_a = response.data.choices[0].message) === null || _a === void 0 ? void 0 : _a.content) || '';
        }
        catch (error) {
            core.error(`Error in generatePRSummary: ${error}`);
            throw new Error(`Failed to generate PR summary: ${error}`);
        }
    });
}
function analyzeFileChanges(openai, filename, patch, context) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        try {
            core.info(`Analyzing changes for file: ${filename}`);
            const response = yield openai.createChatCompletion({
                model: config.openAIModel,
                messages: [
                    {
                        role: 'system',
                        content: "You are a helpful staff engineer who is reviewing code.\nProvide constructive feedback on the code changes. Each of the feedback should be numbered points. Each of the points should have a title called **Observation:** and **Actionable Feedback**.\nAn example is ```3. **Observation:** Potential Performance Issue\n**Actionable Feedback:** If `setPageTitle` involves any non-trivial computation, or if `useSidebarPageStore` has additional side effects, you may want to optimize the trigger. One way is by checking if the title is already 'Tasks' before calling `setPageTitle`.```\nFocus your feedback on the changed parts of the code (lines starting with '+' or '-'), but use the surrounding context to inform your analysis. At the end of your feedback, add a new line with just 'CRITICAL_FEEDBACK:' followed by 'true' if you have substantial or critical feedback, or 'false' if your feedback is minor or just positive.",
                    },
                    {
                        role: 'user',
                        content: `Review the following code changes for file ${filename}:\n\nChanged parts:\n${patch}\n\nBroader file context:\n${context}`,
                    },
                ],
            });
            const content = ((_a = response.data.choices[0].message) === null || _a === void 0 ? void 0 : _a.content) || '';
            const [feedback, criticalIndicator] = content.split('CRITICAL_FEEDBACK:');
            const hasCriticalFeedback = criticalIndicator.trim().toLowerCase() === 'true';
            core.info(`Analysis complete for ${filename}. Critical feedback: ${hasCriticalFeedback}`);
            return { feedback: feedback.trim(), hasCriticalFeedback };
        }
        catch (error) {
            core.error(`Error in analyzeFileChanges for ${filename}: ${error}`);
            throw new Error(`Failed to analyze file changes: ${error}`);
        }
    });
}
function updatePRDescription(octokit, context, summary) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            core.info('Updating PR description...');
            const currentBody = context.payload.pull_request.body || '';
            const newSummary = `## GPT-4 Summary\n\n${summary}`;
            const newBody = `${currentBody}\n\n${newSummary}`;
            yield octokit.rest.pulls.update(Object.assign(Object.assign({}, context.repo), { pull_number: context.payload.pull_request.number, body: newBody }));
            core.info('PR description updated successfully');
        }
        catch (error) {
            core.error(`Error in updatePRDescription: ${error}`);
            throw new Error(`Failed to update PR description: ${error}`);
        }
    });
}
function addPRComment(octokit, context, analyses) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            core.info('Adding PR comment...');
            const criticalAnalyses = analyses.filter((analysis) => analysis.hasCriticalFeedback);
            if (criticalAnalyses.length === 0) {
                core.info('No critical feedback to add to the PR.');
                return;
            }
            let feedbackContent = '## GPT-4 Feedback\n\n';
            for (const analysis of criticalAnalyses) {
                feedbackContent += `### ${analysis.filename}\n\n`;
                feedbackContent += '```diff\n' + analysis.patch + '\n```\n\n';
                feedbackContent += `${analysis.feedback}\n\n`;
            }
            core.info('Creating new feedback comment');
            yield octokit.rest.issues.createComment(Object.assign(Object.assign({}, context.repo), { issue_number: context.payload.pull_request.number, body: feedbackContent }));
            core.info('PR comment added successfully');
        }
        catch (error) {
            core.error(`Error in addPRComment: ${error}`);
            throw new Error(`Failed to add PR comment: ${error}`);
        }
    });
}
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            core.info('Starting code review process...');
            const githubToken = core.getInput('GITHUB_TOKEN', { required: true });
            const openaiApiKey = core.getInput('OPENAI_API_KEY', { required: true });
            const octokit = github.getOctokit(githubToken);
            const openai = new openai_1.OpenAIApi(new openai_1.Configuration({ apiKey: openaiApiKey }));
            const changedFiles = yield getChangedFiles(octokit, github.context);
            core.info('Analyzing changed files...');
            const [prSummary, fileAnalyses] = yield Promise.all([
                generatePRSummary(openai, changedFiles),
                Promise.all(changedFiles.map((file) => __awaiter(this, void 0, void 0, function* () {
                    const fullContent = yield getFileContent(octokit, github.context, file.filename);
                    const contextContent = extractContext(fullContent, file.patch);
                    const { feedback, hasCriticalFeedback } = yield analyzeFileChanges(openai, file.filename, file.patch, contextContent);
                    return {
                        filename: file.filename,
                        feedback,
                        patch: file.patch,
                        hasCriticalFeedback,
                    };
                }))),
            ]);
            core.info('Updating PR description and adding comments...');
            yield Promise.all([
                updatePRDescription(octokit, github.context, prSummary),
                addPRComment(octokit, github.context, fileAnalyses),
            ]);
            core.info('Code review process completed successfully');
        }
        catch (error) {
            core.error(`Error in run function: ${error}`);
            if (error instanceof Error) {
                core.setFailed(error.message);
            }
            else {
                core.setFailed('An unknown error occurred');
            }
        }
    });
}
run();
