/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import { AzureOpenAI } from "openai";
import { AzureClientOptions } from 'openai/src/azure';

export enum ResponseType {
	Completed = "Completed",
	Continue = "Continue",
	Canceled = "Canceled",
	Fail = "Fail",
	TryAgain = "TryAgain",
}

const migrationResponseSystemPrompt = `
You are a helpful assistant that helps the user decide next steps in the migration process.
According to the input, you will decide the status of migration, the status with following options:
- ${ResponseType.Completed}: The migration has been completed successfully, it is ended with the migration summary has been created.
- ${ResponseType.Continue}: The migration is not completed yet or the just migration plan is created, it is wait for your input to continue. 
- ${ResponseType.Canceled}: The operation is canceled for any reason.
- ${ResponseType.Fail}: The migration is failed, please check the error message and fix it.
- ${ResponseType.TryAgain}: There is temporary error please try again.
If there is status in input related with build, please just ignore and you just need to take care about the whole migration status
Just return the next step without any explanation or additional information.`;

export async function decideNextStep(userPrompt: string): Promise<string> {

	const uri = process.env.APPMOD_AZURE_OPENAI_ENDPOINT || "https://migration-benchmark-kaiqian2.cognitiveservices.azure.com/";
	const modelName = process.env.APPMOD_AZURE_OPENAI_DEPLOYMENT || "gpt-4.1";
	const apiVersion = process.env.APPMOD_AZURE_OPENAI_API_VERSION || "2025-01-01-preview";

	if (!uri || !modelName) {
		throw new Error("Missing required environment variables for OpenAI usage.");
	}
	const credential = new DefaultAzureCredential();
	const scope = "https://cognitiveservices.azure.com/.default";
	const azureADTokenProvider = getBearerTokenProvider(credential, scope);
	const deployment = modelName;
	const options = { azureADTokenProvider, deployment, apiVersion };
	(options as AzureClientOptions).endpoint = uri;
	(options as AzureClientOptions).logLevel = 'debug';
	const client = new AzureOpenAI(options);

	const messages: any[] = [
		{ role: "system", content: migrationResponseSystemPrompt },
	];

	messages.push({ role: "user", content: userPrompt });

	const result = await client.chat.completions.create({ messages, model: 'GPT-4o' });
	const response = result.choices[0].message.content ?? "";
	return response;
}