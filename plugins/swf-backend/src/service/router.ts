/*
 * Copyright 2023 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { errorHandler, resolvePackagePath } from '@backstage/backend-common';
import express from 'express';
import Router from 'express-promise-router';
import { Logger } from 'winston';
import { SwfItem, SwfListResult } from '@backstage/plugin-swf-common';
import { ExecException } from 'child_process';
import fetch from 'node-fetch';
import { EventBroker } from '@backstage/plugin-events-node';
import { topic } from '@backstage/plugin-swf-common';
import { Config } from '@backstage/config';
import { DiscoveryApi } from '@backstage/core-plugin-api';
import YAML from 'yaml';
import { resolve } from 'path';
import { exec } from 'child_process';
import fs from 'fs-extra';
import { WorkflowService } from './WorkflowService';

export interface RouterOptions {
  eventBroker: EventBroker;
  config: Config;
  logger: Logger;
  discovery: DiscoveryApi;
}

function delay(time: number) {
  return new Promise(r => setTimeout(r, time));
}

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { eventBroker, config, logger, discovery } = options;

  const router = Router();
  router.use(express.json());

  router.get('/health', (_, response) => {
    logger.info('PONG!');
    response.json({ status: 'ok' });
  });

  const kogitoBaseUrl =
    config.getOptionalString('swf.baseUrl') ?? 'http://localhost';
  const kogitoPort = config.getOptionalNumber('swf.port') ?? 8899;
  logger.info(
    `Using kogito Serverless Workflow Url of: ${kogitoBaseUrl}:${kogitoPort}`,
  );
  const kogitoResourcesPath =
    config.getOptionalString('swf.workflow-service.path') ??
    '../../plugins/swf-backend/workflow-service/src/main/resources:/home/kogito/serverless-workflow-project/src/main/resources';
  const kogitoServiceContainer =
    config.getOptionalString('swf.workflow-service.container') ??
    'quay.io/kiegroup/kogito-swf-devmode:1.40';

  const workflowService = new WorkflowService();

  setupInternalRoutes(router, kogitoBaseUrl, kogitoPort, workflowService);
  setupExternalRoutes(router, discovery);
  await setupKogitoService(
    kogitoBaseUrl,
    kogitoPort,
    kogitoResourcesPath,
    kogitoServiceContainer,
    logger,
  );

  await eventBroker.publish({
    topic: topic,
    eventPayload: {},
  });

  router.use(errorHandler());
  return router;
}

// ==================================================
// Internal Backstage API calls to delegate to Kogito
// ==================================================
function setupInternalRoutes(
  router: express.Router,
  kogitoBaseUrl: string,
  kogitoPort: number,
  workflowService: WorkflowService,
) {
  router.get('/items', async (_, res) => {
    const serviceRes = await fetch(`${kogitoBaseUrl}:${kogitoPort}/q/openapi`);
    const data = YAML.parse((await serviceRes.buffer()).toString());
    const items: SwfItem[] = data.tags?.map((swf: SwfItem) => {
      const swfItem: SwfItem = {
        id: swf.name,
        name: swf.name,
        description: swf.description,
        definition: '',
      };
      return swfItem;
    });
    const result: SwfListResult = {
      items: items ? items : [],
      limit: 0,
      offset: 0,
      totalCount: items ? items.length : 0,
    };
    res.status(200).json(result);
  });

  router.get('/items/:swfId', async (req, res) => {
    const {
      params: { swfId },
    } = req;
    const wsRequest = await fetch(
      `${kogitoBaseUrl}:${kogitoPort}/management/processes/${swfId}/source`,
    );
    const wsResponse = await wsRequest.json();
    const name = wsResponse.name;
    const description = wsResponse.description;
    const swfItem: SwfItem = {
      id: swfId,
      name: name,
      description: description,
      definition: JSON.stringify(wsResponse, undefined, 2),
    };

    // When complete return to Backstage
    res.status(200).json(swfItem);
  });

  router.post('/execute/:swfId', async (req, res) => {
    const {
      params: { swfId },
    } = req;
    const swfData = req.body;
    const swfRequest = await fetch(`${kogitoBaseUrl}:${kogitoPort}/${swfId}`, {
      method: 'POST',
      body: JSON.stringify(swfData),
      headers: { 'content-type': 'application/json' },
    });
    const response = await swfRequest.json();
    res.status(swfRequest.status).json(response);
  });

  router.get('/instances', async (_, res) => {
    const graphQlQuery =
      '{ ProcessInstances (where: {processId: {isNull: false} } ) { id, processId, state, start, nodes { id }, variables } }';
    const serviceRes = await fetch(`${kogitoBaseUrl}:${kogitoPort}/graphql`, {
      method: 'POST',
      body: JSON.stringify({ query: graphQlQuery }),
      headers: { 'content-type': 'application/json' },
    });
    const response = await serviceRes.json();
    res.status(200).json(response);
  });

  router.get('/instances/:instanceId', async (req, res) => {
    const {
      params: { instanceId },
    } = req;
    const graphQlQuery = `{ ProcessInstances (where: { id: {equal: "${instanceId}" } } ) { id, processId, state, start, nodes { id, nodeId, type, name, enter, exit }, variables } }`;
    const serviceRes = await fetch(`${kogitoBaseUrl}:${kogitoPort}/graphql`, {
      method: 'POST',
      body: JSON.stringify({ query: graphQlQuery }),
      headers: { 'content-type': 'application/json' },
    });
    const response = await serviceRes.json();
    res.status(200).json(response);
  });

  router.post('/workflows', async (req, res) => {
    const url = req.query.url;
    const swfData = req.body;
    let createdWorkflow;
    if (url && url.includes(`http`)) {
      createdWorkflow = await workflowService.saveWorkflowDefinitionFromUrl(
        url,
      );
    } else {
      createdWorkflow = await workflowService.saveWorkflowDefinition(swfData);
    }

    const swfItem: SwfItem = {
      id: createdWorkflow.id,
      definition: JSON.stringify(createdWorkflow),
      name: ``,
      description: ``,
    };
    res.status(201).json(swfItem).send();
  });
}

// ==================================================
// External Kogito API calls to delegate to Backstage
// ==================================================
function setupExternalRoutes(router: express.Router, discovery: DiscoveryApi) {
  router.get('/actions', async (_, res) => {
    const scaffolderUrl = await discovery.getBaseUrl('scaffolder');
    const response = await fetch(`${scaffolderUrl}/v2/actions`);
    const json = await response.json();
    res.status(response.status).json(json);
  });

  router.post('/actions/:actionId', async (req, res) => {
    const { actionId } = req.params;
    const scaffolderUrl = await discovery.getBaseUrl('scaffolder');
    const requestBody = req.body;
    const wsRequest = await fetch(`${scaffolderUrl}/v2/actions/${actionId}`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      headers: { 'content-type': 'application/json' },
    });
    const response = await wsRequest.json();
    res.status(wsRequest.status).json(response);
  });
}

// =========================================
// Spawn a process to run the Kogito service
// =========================================
async function setupKogitoService(
  kogitoBaseUrl: string,
  kogitoPort: number,
  kogitoResourcesPath: string,
  kogitoServiceContainer: string,
  logger: Logger,
) {
  const kogitoResourcesAbsPath = resolve(`${kogitoResourcesPath}`);
  const launcher = `docker run --add-host host.docker.internal:host-gateway --rm -p ${kogitoPort}:8080 -v ${kogitoResourcesAbsPath}:/home/kogito/serverless-workflow-project/src/main/resources ${kogitoServiceContainer}`;
  exec(
    launcher,
    (error: ExecException | null, stdout: string, stderr: string) => {
      if (error) {
        console.error(`error: ${error.message}`);
        return;
      }

      if (stderr) {
        console.error(`stderr: ${stderr}`);
        return;
      }

      console.log(`stdout:\n${stdout}`);
    },
  );

  // We need to ensure the service is running!
  let retryCount = 0;
  let polling = true;
  while (polling) {
    try {
      const healthCheckResponse = await fetch(
        `${kogitoBaseUrl}:${kogitoPort}/q/health`,
      );
      polling = !healthCheckResponse.ok;
      if (!healthCheckResponse.ok) {
        // Throw local error to re-use retry mechanism.
        throw new Error('Retry');
      }
    } catch (e) {
      retryCount++;
      await delay(5000);
      if (retryCount > 10) {
        logger.error(
          'Kogito failed to start. Serverless Workflow Templates could not be loaded.',
        );
        polling = false;
      }
    }
  }
}
