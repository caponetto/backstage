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
import { errorHandler } from '@backstage/backend-common';
import express from 'express';
import Router from 'express-promise-router';
import { Logger } from 'winston';
import {
  ProcessInstance,
  SwfItem,
  SwfListResult,
  topic,
} from '@backstage/plugin-swf-common';
import { exec, ExecException } from 'child_process';
import { EventBroker } from '@backstage/plugin-events-node';
import { Config } from '@backstage/config';
import { DiscoveryApi } from '@backstage/core-plugin-api';
import YAML from 'yaml';
import { resolve } from 'path';
import { WorkflowService } from './WorkflowService';
import { OpenApiService } from './OpenApiService';
import { DataInputSchemaService } from './DataInputSchemaService';

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
    '../../plugins/swf-backend/workflows:/home/kogito/serverless-workflow-project/src/main/resources';
  const kogitoServiceContainer =
    config.getOptionalString('swf.workflow-service.container') ??
    'quay.io/kiegroup/kogito-swf-devmode-nightly:latest';

  const githubToken = process.env.BACKSTAGE_GITHUB_TOKEN;
  const openApiService = new OpenApiService(logger, discovery);
  const dataInputSchemaService = new DataInputSchemaService(
    logger,
    githubToken,
  );

  const workflowService = new WorkflowService(
    openApiService,
    dataInputSchemaService,
  );

  setupInternalRoutes(
    router,
    kogitoBaseUrl,
    kogitoPort,
    workflowService,
    openApiService,
  );
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
  openApiService: OpenApiService,
) {
  router.get('/items', async (_, res) => {
    const svcResponse = await executeWithRetry(() =>
      fetch(`${kogitoBaseUrl}:${kogitoPort}/q/openapi`),
    );
    const yaml = YAML.parse(await svcResponse.text());
    const items: SwfItem[] = yaml.tags?.map((swf: SwfItem) => {
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

    const svcResponse = await executeWithRetry(() =>
      fetch(
        `${kogitoBaseUrl}:${kogitoPort}/management/processes/${swfId}/source`,
      ),
    );
    const json = await svcResponse.json();
    const name = json.name;
    const description = json.description;
    const swfItem: SwfItem = {
      id: swfId,
      name: name,
      description: description,
      definition: JSON.stringify(json, undefined, 2),
    };

    // When complete return to Backstage
    res.status(200).json(swfItem);
  });

  router.post('/execute/:swfId', async (req, res) => {
    const {
      params: { swfId },
    } = req;
    const swfData = req.body;
    const svcResponse = await fetch(`${kogitoBaseUrl}:${kogitoPort}/${swfId}`, {
      method: 'POST',
      body: JSON.stringify(swfData),
      headers: { 'content-type': 'application/json' },
    });
    const json = await svcResponse.json();
    res.status(svcResponse.status).json(json);
  });

  router.get('/instances', async (_, res) => {
    const graphQlQuery =
      '{ ProcessInstances (where: {processId: {isNull: false} } ) { id, processName, processId, state, start, lastUpdate, end, nodes { id }, variables, parentProcessInstance {id, processName, businessKey} } }';
    const svcResponse = await executeWithRetry(() =>
      fetch(`${kogitoBaseUrl}:${kogitoPort}/graphql`, {
        method: 'POST',
        body: JSON.stringify({ query: graphQlQuery }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    const json = await svcResponse.json();
    const processInstances: ProcessInstance[] = json.data
      .ProcessInstances as ProcessInstance[];
    res.status(200).json(processInstances);
  });

  router.get('/instances/:instanceId', async (req, res) => {
    const {
      params: { instanceId },
    } = req;
    const graphQlQuery = `{ ProcessInstances (where: { id: {equal: "${instanceId}" } } ) { id, processName, processId, state, start, lastUpdate, end, nodes { id, nodeId, definitionId, type, name, enter, exit }, variables, parentProcessInstance {id, processName, businessKey}, error { nodeDefinitionId, message} } }`;
    const svcResponse = await executeWithRetry(() =>
      fetch(`${kogitoBaseUrl}:${kogitoPort}/graphql`, {
        method: 'POST',
        body: JSON.stringify({ query: graphQlQuery }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    const json = await svcResponse.json();
    const processInstances: ProcessInstance[] = json.data
      .ProcessInstances as ProcessInstance[];
    const processInstance: ProcessInstance = processInstances[0];
    res.status(200).json(processInstance);
  });

  router.delete('/workflows/:swfId', async (req, res) => {
    const swfId = req.params.swfId;
    await workflowService.deleteWorkflowDefinitionById(swfId);
    res.status(201).send();
  });

  router.post('/workflows', async (req, res) => {
    const url: any = req.query.url;
    let swfData = req.body;
    if (url && url.includes(`http`)) {
      swfData = await workflowService.saveWorkflowDefinitionFromUrl(url);
    } else {
      swfData = await workflowService.saveWorkflowDefinition(swfData);
    }

    const swfItem: SwfItem = {
      id: swfData.id,
      definition: JSON.stringify(swfData),
      name: ``,
      description: ``,
    };
    res.status(201).json(swfItem).send();
  });

  router.get('/actions/schema', async (_, res) => {
    const openApi = await openApiService.generateOpenApi();
    res.json(openApi).status(200).send();
  });

  router.put('/actions/schema', async (_, res) => {
    const openApi = await workflowService.saveOpenApi();
    res.json(openApi).status(200).send();
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
    const processInstanceId = req.header('kogitoprocinstanceid');
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    if (processInstanceId) {
      headers.set('kogitoprocinstanceid', processInstanceId);
    }
    const wsRequest = await fetch(`${scaffolderUrl}/v2/actions/${actionId}`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      headers: headers,
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
  const launcher = `docker run --add-host host.docker.internal:host-gateway --rm -p ${kogitoPort}:8080 -v ${kogitoResourcesAbsPath}:/home/kogito/serverless-workflow-project/src/main/resources -e KOGITO.CODEGEN.PROCESS.FAILONERROR=false ${kogitoServiceContainer}`;
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
  try {
    await executeWithRetry(() =>
      fetch(`${kogitoBaseUrl}:${kogitoPort}/q/health`),
    );
  } catch (e) {
    logger.error(
      'Kogito failed to start. Serverless Workflow Templates could not be loaded.',
    );
  }
}

async function executeWithRetry(
  action: () => Promise<Response>,
): Promise<Response> {
  let response: Response;
  let errorCount = 0;
  // execute with retry
  const backoff = 5000;
  const maxErrors = 15;
  while (errorCount < maxErrors) {
    try {
      response = await action();
      if (response.status >= 400) {
        errorCount++;
        // backoff
        await delay(backoff);
      } else {
        return response;
      }
    } catch (e) {
      errorCount++;
      await delay(backoff);
    }
  }
  throw new Error('Unable to execute query.');
}
