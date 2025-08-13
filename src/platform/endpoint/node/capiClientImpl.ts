/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEnvService } from '../../env/common/envService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { BaseCAPIClientService } from '../common/capiClient';
/* eslint-disable local/no-test-imports */
/* eslint-disable import/no-restricted-paths */
import { logger } from '../../../../test/simulationLogger';

export class CAPIClientImpl extends BaseCAPIClientService {

	constructor(
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService
	) {
		logger.info(`the hmac is ${process.env.HMAC_SECRET}`);
		super(process.env.HMAC_SECRET, fetcherService, envService);
	}
}