/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Allow importing vscode here. eslint does not let us exclude this path: https://github.com/import-js/eslint-plugin-import/issues/2800
/* eslint-disable import/no-restricted-paths */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { CancellationToken, ChatRequest, LanguageModelTool, LanguageModelToolInformation, LanguageModelToolInvocationOptions, LanguageModelToolResult } from 'vscode';
import { getToolName, ToolName } from '../../../src/extension/tools/common/toolNames';
import { ICopilotTool } from '../../../src/extension/tools/common/toolsRegistry';
import { BaseToolsService, IToolsService } from '../../../src/extension/tools/common/toolsService';
import { getPackagejsonToolsForTest } from '../../../src/extension/tools/node/test/testToolsService';
import { McpToolsService } from '../../../src/extension/tools/vscode-node/mcpToolsService';
import { ToolsContribution } from '../../../src/extension/tools/vscode-node/tools';
import { ToolsService } from '../../../src/extension/tools/vscode-node/toolsService';
import { packageJson } from '../../../src/platform/env/common/packagejson';
import { ILogService } from '../../../src/platform/log/common/logService';
import { IChatEndpoint } from '../../../src/platform/networking/common/networking';
import { raceTimeout } from '../../../src/util/vs/base/common/async';
import { CancellationError } from '../../../src/util/vs/base/common/errors';
import { Iterable } from '../../../src/util/vs/base/common/iterator';
import { observableValue } from '../../../src/util/vs/base/common/observableInternal';
import { URI } from '../../../src/util/vs/base/common/uri';
import { IInstantiationService } from '../../../src/util/vs/platform/instantiation/common/instantiation';
import { PromptFileParser } from '../../../src/util/vs/workbench/contrib/chat/common/promptSyntax/promptFileParser';
import { logger } from '../../simulationLogger';

export class SimulationExtHostToolsService extends BaseToolsService implements IToolsService {
	declare readonly _serviceBrand: undefined;

	private readonly _inner: IToolsService;
	private readonly _mcpToolService: IToolsService;
	private readonly _overrides = new Map<ToolName | string, { info: LanguageModelToolInformation; tool: ICopilotTool<any> }>();
	private _lmToolRegistration?: ToolsContribution;
	private counter: number;
	private readonly _customAgentToolSet: Set<String> = new Set<String>();

	override get onWillInvokeTool() {
		return this._inner.onWillInvokeTool;
	}

	get tools() {
		this.ensureToolsRegistered();
		return [
			...this._inner.tools.filter(t => !this._disabledTools.has(t.name) && !this._overrides.has(t.name)),
			...Iterable.filter(Iterable.map(this._overrides.values(), i => i.info), t => !this._disabledTools.has(t.name)),
			...this._mcpToolService.tools.filter(t => !this._disabledTools.has(t.name) && !this._overrides.has(t.name)),
		];
	}

	get copilotTools() {
		const r = new Map([
			...this._inner.copilotTools,
			...Iterable.map(this._overrides, ([k, v]): [ToolName, ICopilotTool<any>] => [k as ToolName, v.tool]),
		]);
		for (const name of this._disabledTools) {
			r.delete(name as ToolName);
		}
		return r;
	}

	constructor(
		private readonly _disabledTools: Set<string>,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(logService);
		this._inner = instantiationService.createInstance(ToolsService);
		this._mcpToolService = instantiationService.createInstance(McpToolsService) as unknown as IToolsService;

		// register the contribution so that our tools are on vscode.lm.tools
		setImmediate(() => this.ensureToolsRegistered());
		this.counter = 0;

		this._registerDefaultOverrides();

		if (process.env.SIMULATION_CUSTOM_AGENT_FILE) {
			const agentFilePath = process.env.SIMULATION_CUSTOM_AGENT_FILE;
			if (fs.existsSync(agentFilePath)) {
				const agentFileContent = fs.readFileSync(agentFilePath, 'utf-8');
				const agentFileUri = URI.file(agentFilePath);
				const parser = new PromptFileParser();
				const parsedFile = parser.parse(agentFileUri, agentFileContent);

				parsedFile.header?.tools?.map(toolName => this._customAgentToolSet.add(toolName));
			}
		}
	}

	private ensureToolsRegistered() {
		this._lmToolRegistration ??= new ToolsContribution(this, {} as any, { threshold: observableValue(this, 128) } as any, {} as any);
	}

	getCopilotTool(name: string): ICopilotTool<any> | undefined {
		return this._disabledTools.has(name) ? undefined : (this._overrides.get(name)?.tool || this._inner.getCopilotTool(name) || this._mcpToolService.getCopilotTool(name));
	}

	async invokeTool(name: string, options: LanguageModelToolInvocationOptions<unknown>, token: CancellationToken): Promise<LanguageModelToolResult> {
		logger.debug('😈=== SimulationExtHostToolsService.invokeTool', name, JSON.stringify(options.input));
		const start = Date.now();
		let err: Error | undefined;
		try {
			const toolName = getToolName(name) as ToolName;
			const tool = this._overrides.get(toolName)?.tool;
			const invoke = tool?.invoke;
			if (invoke) {
				this._onWillInvokeTool.fire({ toolName });
				const result = await invoke.call(tool, options, token);
				if (!result) {
					throw new CancellationError();
				}

				return result;
			}

			if (tool) {
				throw new Error(`tool ${toolName} does not implement invoke`);
			}

			const mcpTool = this._mcpToolService.getTool(name);
			if (mcpTool) {
				const result = await this._mcpToolService.invokeTool(name, options, token);
				if (!result) {
					throw new CancellationError();
				}

				return result;
			}

			const invokeToolTimeout = (process.env.SIMULATION_INVOKE_TOOL_TIMEOUT || 60_000) as number;
			const r = await raceTimeout(Promise.resolve(this._inner.invokeTool(name, options, token)), <number>invokeToolTimeout);
			if (!r) {
				throw new Error(`Tool call timed out after ${invokeToolTimeout / 60_000} minutes`);
			}
			return r;
		} catch (e) {
			err = e;
			throw e;
		} finally {
			logger.debug(`😈=== SimulationExtHostToolsService.invokeTool ${name} done in ${Date.now() - start}ms` + (err ? ` with error: ${err.message}` : ''));
		}
	}

	getTool(name: string): LanguageModelToolInformation | undefined {
		return this._disabledTools.has(name) ? undefined : (this._overrides.get(name)?.info || this._inner.getTool(name) || this._mcpToolService.getTool(name));
	}

	getToolByToolReferenceName(toolReferenceName: string): LanguageModelToolInformation | undefined {
		const contributedTool = packageJson.contributes.languageModelTools.find(tool => tool.toolReferenceName === toolReferenceName && tool.canBeReferencedInPrompt);
		if (contributedTool) {
			return {
				name: contributedTool.name,
				description: contributedTool.modelDescription,
				inputSchema: contributedTool.inputSchema,
				source: undefined,
				tags: []
			};
		}

		return undefined;
	}

	getEnabledTools(request: ChatRequest, endpoint: IChatEndpoint, filter?: (tool: LanguageModelToolInformation) => boolean | undefined): LanguageModelToolInformation[] {
		const packageJsonTools = getPackagejsonToolsForTest();

		const allowedToolsSet = new Set<string>();
		let javaUpgradeToolsFromFile: string[] = [];
		if (process.env.JAVA_UPGRADE_TOOLS) {
			try {
				const config = fs.readFileSync(process.env.JAVA_UPGRADE_TOOLS, 'utf8');
				javaUpgradeToolsFromFile = config
					.split('\n')
					.map(line => line.trim())
					.filter(line => line && !line.startsWith('#')); // Filter out empty lines and comments
				javaUpgradeToolsFromFile.forEach(tool => allowedToolsSet.add(tool));
			} catch (error) {
				logger.warn('😈=== Failed to read Java upgrade tools file:', error);
			}
		}

		const tools = this.tools
			.map(tool => {
				// Apply model-specific alternative if available via alternativeDefinition
				const owned = this.copilotTools.get(getToolName(tool.name) as ToolName);
				if (owned?.alternativeDefinition) {
					const alternative = owned.alternativeDefinition(tool, endpoint);
					if (alternative) {
						return alternative;
					}
				}
				return tool;
			})
			.filter(tool => filter?.(tool) ?? (
				!this._disabledTools.has(getToolName(tool.name))
				&& (
					(process.env.JAVA_UPGRADE_TOOLS && tool.name.startsWith("appmod"))
					|| (packageJsonTools.has(tool.name) && tool.name !== 'semantic_search')
					|| allowedToolsSet.has(tool.name)
				)
			))
			;

		this._mcpToolService.getEnabledTools(request, endpoint, filter);

		// Wait for MCP servers to be initialized
		const maxWaitTime = 60000; // 60 seconds maximum wait time
		const checkInterval = 1000; // Check every 1000ms
		const startTime = Date.now();

		while (process.env.MCP_SERVERS_INITIALIZED !== 'true' && (Date.now() - startTime) < maxWaitTime) {
			// Use a synchronous sleep method that doesn't require external dependencies
			const sleepStart = Date.now();
			while (Date.now() - sleepStart < checkInterval) {
			}
		}

		while (process.env.MCP_SERVERS_INITIALIZED !== 'true' && (Date.now() - startTime) < maxWaitTime) {
			// Proper synchronous sleep using SharedArrayBuffer and Atomics
			try {
				const sharedBuffer = new SharedArrayBuffer(4);
				const sharedArray = new Int32Array(sharedBuffer);
				console.log("SimulationExtHostToolsService: MCP servers are still initializing");
				Atomics.wait(sharedArray, 0, 0, checkInterval);
			} catch {
				// Fallback to a much more efficient busy wait
				const sleepStart = Date.now();
				while (Date.now() - sleepStart < checkInterval) {
					// Only check every 10ms instead of continuously
					if ((Date.now() - sleepStart) % 10 === 0) {
						// Allow other operations to run
						continue;
					}
				}
			}
		}

		if (process.env.MCP_SERVERS_INITIALIZED !== 'true') {
			logger.debug('😈=== SimulationExtHostToolsService: MCP servers initialization timed out');
		}

		const mcpTools = this._mcpToolService.getEnabledTools(request, endpoint, filter);
		const allToolsMap = new Map<string, LanguageModelToolInformation>();
		for (const t of tools) {
			allToolsMap.set(t.name, t);
		}
		for (const t of mcpTools) {
			allToolsMap.set(t.name, t);
		}
		let allTools = Array.from(allToolsMap.values());
		let enabledTools = allTools;

		if (this._customAgentToolSet.size > 0) {
			enabledTools = allTools.filter(tool => this._customAgentToolSet.has(tool.name));
		}

		if (process.env.MCP_SERVERS_INITIALIZED === 'true' && this.counter++ === 0) {
			if (process.env.JAVA_UPGRADE_TOOLS) {
				logger.debug('😈=== Loaded Java upgrade tools from file:', javaUpgradeToolsFromFile);
			}
			if (this._customAgentToolSet.size > 0) {
				logger.debug(`😈=== Load custom agent from ${process.env.SIMULATION_CUSTOM_AGENT_FILE}, to filter available tools`);
			}
			logger.debug('😈=== SimulationExtHostToolsService.allToos', allTools.length, allTools.map(tool => tool.name).join(', '));
			logger.debug('😈=== SimulationExtHostToolsService.mcpTools', mcpTools.length, Array.from(mcpTools.values()).map(tool => tool.name).join(', '));
			logger.debug('😈=== SimulationExtHostToolsService.getEnabledTool', enabledTools.length, enabledTools.map(t => t.name).join(","));
			logger.debug(`😈=== SimulationExtHostToolsService.invokeToolTimeout set to ${process.env.SIMULATION_INVOKE_TOOL_TIMEOUT || 60_000}`);
		}
		return enabledTools;
	}

	addTestToolOverride(info: LanguageModelToolInformation, tool: LanguageModelTool<unknown>): void {
		if (!this._disabledTools.has(info.name)) {
			this._overrides.set(info.name as ToolName, { tool, info });
		}
	}

	private _registerDefaultOverrides() {
		// Real runSubagent implementation
		const runSubagentTool = {
			async invoke(
				options: LanguageModelToolInvocationOptions<any>,
				_token: CancellationToken
			): Promise<LanguageModelToolResult> {
				var { prompt, agentName, model } = options.input;
				agentName = 'default';
				console.log(`[Subagent] Invoking with prompt: ${prompt}, agent: ${agentName}, model: ${model}`);
				const vscode = await import('vscode');

				// 1. Prepare temp directory
				const workspacePath = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
				if (!workspacePath) {
					throw new Error('No workspace folder found');
				}
				console.log(`[Subagent] Workspace path: ${workspacePath}`);

				const simulationTempDir = path.join(workspacePath, '.simulation', 'temp');
				if (!fs.existsSync(simulationTempDir)) {
					fs.mkdirSync(simulationTempDir, { recursive: true });
				}
				const tempDir = fs.mkdtempSync(path.join(simulationTempDir, 'copilot-subagent-'));
				console.log(`[Subagent] Using temp dir: ${tempDir}`);

				// Create separate directories for scenarios (input) and output
				// This is needed because simulationMain.ts clears the output directory
				const scenariosDir = path.join(tempDir, 'scenarios');
				const outputDir = path.join(tempDir, 'output');
				fs.mkdirSync(scenariosDir, { recursive: true });
				fs.mkdirSync(outputDir, { recursive: true });

				try {
					// 2. Create state file
					// Note: workspaceFoldersFilePaths must be relative to the scenario folder (scenariosDir)
					// Use a relative path from scenariosDir to workspacePath
					const stateFile = 'chatSetup.state.json';
					const relativeWorkspacePath = path.relative(scenariosDir, workspacePath);
					const stateContent = {
						workspaceFoldersFilePaths: [relativeWorkspacePath]
					};
					fs.writeFileSync(path.join(scenariosDir, stateFile), JSON.stringify(stateContent));

					// 3. Create conversation file
					const conversationFile = 'subagent.conversation.json';
					const fullPrompt = agentName ? `@${agentName} ${prompt}` : prompt;
					const conversationContent = [
						{
							question: fullPrompt,
							stateFile: stateFile
						}
					];
					fs.writeFileSync(path.join(scenariosDir, conversationFile), JSON.stringify(conversationContent));
					console.log(`[Subagent] Created configuration files in ${scenariosDir}`);

					// 5. Spawn simulation process
					let simulationMainPath = path.join(__dirname, '../../../../simulationMain.js');
					if (!fs.existsSync(simulationMainPath)) {
						// Fallback: try to find it from process.cwd()
						simulationMainPath = path.join(process.cwd(), 'dist', 'simulationMain.js');
					}

					if (!fs.existsSync(simulationMainPath)) {
						throw new Error(`Could not find simulationMain.js at ${simulationMainPath}`);
					}

					const args = [
						simulationMainPath,
						`--external-scenarios=${scenariosDir}`,
						`--output=${outputDir}`,
						'--json',
						'--disable-tools=runSubagent', // Prevent recursion
						'--sidebar',
						'--headless',
						'--in-extension-host',
						'--n=1',
						'--scenario-workspace-folder',
						'--verbose',
						'--parallelism=1',
						'--skip-cache'
					];

					const env: any = { ...process.env, SIMULATION_SUBAGENT: '1' };
					delete env.VSCODE_SIMULATION_EXTENSION_ENTRY;

					console.log(`[Subagent] Spawning process: node ${args.join(' ')}`);

					return await new Promise<LanguageModelToolResult>((resolve, reject) => {
						const child = cp.spawn('node', args, {
							env
						});

						let stdout = '';
						let stderr = '';

						child.stdout.on('data', (data) => stdout += data.toString());
						child.stderr.on('data', (data) => stderr += data.toString());

						child.on('close', (code) => {
							console.log(`[Subagent] Process exited with code ${code}`);
							if (code !== 0) {
								console.error(`[Subagent] Stderr: ${stderr}`);
								console.log(`[Subagent] Stdout: ${stdout}`);
								reject(new Error(`Subagent process exited with code ${code}\nStderr: ${stderr}\nStdout: ${stdout}`));
								return;
							}

							// 6. Parse report
							try {
								const reportPath = path.join(outputDir, 'report.json');
								if (!fs.existsSync(reportPath)) {
									reject(new Error(`Subagent did not produce report.json\nStdout: ${stdout}\nStderr: ${stderr}`));
									return;
								}

								const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
								if (!report || report.length === 0) {
									reject(new Error('Subagent report is empty'));
									return;
								}

								const result = report[0];
								const outcome = result.outcomes?.[0];
								if (!outcome) {
									reject(new Error('Subagent produced no outcome'));
									return;
								}

								const responseText = outcome.content || 'No response text';
								console.log(`[Subagent] Success. Response length: ${responseText}`);

								resolve(new vscode.LanguageModelToolResult([
									new vscode.LanguageModelTextPart(responseText)
								]));

							} catch (e) {
								console.error(`[Subagent] Error parsing output: ${e}`);
								reject(new Error(`Failed to parse subagent output: ${e.message}`));
							}
						});
					});
				} finally {
					// Cleanup temp dir
					try {
						console.log(`[Subagent] Cleaning up ${tempDir}`);
						fs.rmSync(tempDir, { recursive: true, force: true });
					} catch (e) {
						// Ignore cleanup errors
						console.error(`[Subagent] Error cleaning up: ${e}`);
					}
				}
			}
		};

		this.addTestToolOverride(
			{
				name: ToolName.CoreRunSubagent,
				description: 'Launch a new agent to handle complex, multi-step tasks autonomously',
				inputSchema: {
					type: 'object',
					properties: {
						prompt: { type: 'string' },
						description: { type: 'string' },
						agentName: { type: 'string' }
					},
					required: ['prompt', 'description']
				},
				tags: [],
				source: undefined
			},
			runSubagentTool
		);
	}
}
