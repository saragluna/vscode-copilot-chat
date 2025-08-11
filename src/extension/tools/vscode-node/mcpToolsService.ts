/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'fs';
import * as vscode from 'vscode';
/* eslint-disable import/no-restricted-paths */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CancellationError, LanguageModelTextPart, LanguageModelToolInformation, LanguageModelToolResult } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { getContributedToolName, getToolName, mapContributedToolNamesInSchema, mapContributedToolNamesInString, ToolName } from '../common/toolNames';
import { ICopilotTool } from '../common/toolsRegistry';
import { BaseToolsService } from '../common/toolsService';
// eslint-disable-next-line no-duplicate-imports
import { LanguageModelToolResult2 } from 'vscode';
import { logger } from '../../../../test/simulationLogger';

type McpServers = {
	servers: {
		[key: string]: {
			type: string;
			command: string;
			args: string[];
			env?: Record<string, string>;
			cwd?: string;
		};
	};
}

export class McpToolsService extends BaseToolsService {
	declare _serviceBrand: undefined;

	private readonly _copilotTools: Lazy<Map<ToolName, ICopilotTool<any>>>;
	private mcpTools: vscode.LanguageModelToolInformation[] = [];
	private readonly mcpClients: Map<string, Client> = new Map();
	private readonly toolToServerMap: Map<string, string> = new Map();

	get tools(): ReadonlyArray<vscode.LanguageModelToolInformation> {
		return this.mcpTools.map(tool => {
			return {
				...tool,
				name: getToolName(tool.name),
				description: mapContributedToolNamesInString(tool.description),
				inputSchema: tool.inputSchema && mapContributedToolNamesInSchema(tool.inputSchema),
			};
		});
	}

	public get copilotTools() {
		return this._copilotTools.value;
	}

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService
	) {
		super(logService);
		this._copilotTools = new Lazy(() => new Map());
		if (process.env.MCP_CONFIG_FILE !== undefined) {
			const config = fs.readFileSync(process.env.MCP_CONFIG_FILE, 'utf8');
			const mcpServers: McpServers = JSON.parse(config);

			for (const [name, server] of Object.entries(mcpServers.servers)) {
				let transport;
				const configuredEnv = server.env ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, replaceEnvVariables(value)])) : undefined;
				// combine env with process.env, ensuring all values are strings (no undefined)
				const rawEnv = configuredEnv ? { ...process.env, ...configuredEnv } : process.env;
				const combinedEnv: Record<string, string> = {};
				for (const [key, value] of Object.entries(rawEnv)) {
					if (typeof value === 'string') {
						combinedEnv[key] = value;
					}
				}

				if (server.type === 'stdio') {
					transport = new StdioClientTransport({
						command: replaceEnvVariables(server.command),
						args: server.args.map(arg => replaceEnvVariables(arg)),
						env: combinedEnv,
						stderr: 'inherit', // Default behavior, can be customized if needed
						cwd: server.cwd ? replaceEnvVariables(server.cwd) : undefined,
					});
				} else {
					logger.warn(`Unsupported MCP transport type: ${server.type} for server ${name}`);
					continue; // Unsupported transport type
				}

				// Create a separate client for each server
				const mcpClient = new Client({ name: `mcp-client-${name}`, version: '1.0.0' });
				this.mcpClients.set(name, mcpClient);

				mcpClient.connect(transport).then(async () => {
					const mcpTools = (await mcpClient.listTools()).tools;
					for (const tool of mcpTools) {
						const info: LanguageModelToolInformation = {
							name: tool.name,
							description: tool.description as string,
							inputSchema: tool.inputSchema,
							tags: ['vscode_editing'],
							source: { name: 'mcp', label: `MCP Server: ${name}` },
						};
						this.mcpTools.push(info);
						// Map tool name to server name for later lookup
						this.toolToServerMap.set(tool.name, name);
					}
					logger.info(`Connected to MCP server ${name} with transport ${JSON.stringify(transport)} and tools: ${JSON.stringify(mcpTools)}`);
				}).catch(error => {
					logger.error(`Failed to connect to MCP server ${name}: ${error}`);
				});
			}
		}
	}

	async invokeTool(name: string | ToolName, options: vscode.LanguageModelToolInvocationOptions<Object>, token: vscode.CancellationToken): Promise<LanguageModelToolResult | LanguageModelToolResult2> {
		this._onWillInvokeTool.fire({ toolName: name });

		// Find which server provides this tool
		const serverName = this.toolToServerMap.get(name as string);
		if (!serverName) {
			throw new Error(`Tool ${name} not found in any MCP server`);
		}

		const mcpClient = this.mcpClients.get(serverName);
		if (!mcpClient) {
			throw new Error(`MCP client for server ${serverName} not found`);
		}

		const result = await mcpClient.callTool({
			name: name,
			arguments: options.input as Record<string, unknown>,
		});
		if (!result) {
			throw new CancellationError();
		}
		const parts = [];
		for (const part of result.content as { text: string }[]) {
			parts.push(new LanguageModelTextPart(part.text as string));
		}
		return new LanguageModelToolResult(parts);
	}

	override getCopilotTool(name: string): ICopilotTool<any> | undefined {
		const tool = this._copilotTools.value.get(name as ToolName);
		return tool;
	}

	getTool(name: string | ToolName): vscode.LanguageModelToolInformation | undefined {
		return this.tools.find(tool => tool.name === name);
	}

	getToolByToolReferenceName(name: string): vscode.LanguageModelToolInformation | undefined {
		// Can't actually implement this in prod, name is not exposed
		throw new Error('This method for tests only');
	}

	getEnabledTools(request: vscode.ChatRequest, filter?: (tool: vscode.LanguageModelToolInformation) => boolean | undefined): vscode.LanguageModelToolInformation[] {
		const toolMap = new Map(this.tools.map(t => [t.name, t]));

		return this.tools.filter(tool => {
			// 0. Check if the tool was disabled via the tool picker. If so, it must be disabled here
			const toolPickerSelection = request.tools.get(getContributedToolName(tool.name));
			if (toolPickerSelection === false) {
				return false;
			}

			// 1. Check for what the consumer wants explicitly
			const explicit = filter?.(tool);
			if (explicit !== undefined) {
				return explicit;
			}

			// 2. Check if the request's tools explicitly asked for this tool to be enabled
			for (const ref of request.toolReferences) {
				const usedTool = toolMap.get(ref.name);
				if (usedTool?.tags.includes(`enable_other_tool_${tool.name}`)) {
					return true;
				}
			}

			// 3. If this tool is neither enabled nor disabled, then consumer didn't have opportunity to enable/disable it.
			// This can happen when a tool is added during another tool call (e.g. installExt tool installs an extension that contributes tools).
			if (toolPickerSelection === undefined && tool.tags.includes('extension_installed_by_tool')) {
				return true;
			}

			// Tool was enabled via tool picker
			if (toolPickerSelection === true) {
				return true;
			}

			return false;
		});
	}

	/**
	 * Dispose of all MCP client connections
	 */
	override dispose(): void {
		super.dispose();

		for (const [serverName, client] of this.mcpClients) {
			try {
				client.close();
				logger.info(`Closed MCP client connection for server: ${serverName}`);
			} catch (error) {
				logger.error(`Error closing MCP client for server ${serverName}: ${error}`);
			}
		}
		this.mcpClients.clear();
		this.toolToServerMap.clear();
	}
}

function replaceEnvVariables(str: string): string {
	return str.replace(/\$\{([^}]+)\}/g, (match: string, varName: string) => {
		return process.env[varName] || '';
	});
}
