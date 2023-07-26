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
import { resolvePackagePath } from '@backstage/backend-common';
import fs from 'fs-extra';
import { OpenApiService } from './OpenApiService';
import {
  actions_open_api_file_path,
  schemas_folder,
} from '@backstage/plugin-swf-common';
import { Specification } from '@severlessworkflow/sdk-typescript';
import { DataInputSchemaService } from './DataInputSchemaService';
import { join } from 'path';

export class WorkflowService {
  private openApiService: OpenApiService;
  private dataInputSchemaService: DataInputSchemaService;
  private readonly resourcesPath = `workflows`;

  constructor(
    openApiService: OpenApiService,
    dataInputSchemaService: DataInputSchemaService,
  ) {
    this.openApiService = openApiService;
    this.dataInputSchemaService = dataInputSchemaService;
  }

  async saveWorkflowDefinition(
    workflow: Specification.Workflow,
  ): Promise<Specification.Workflow> {
    const definitionsPath = resolvePackagePath(
      `@backstage/plugin-swf-backend`,
      `${this.resourcesPath}/${workflow.id}.sw.json`,
    );
    const dataInputSchemaPath = await this.saveDataInputSchema(workflow);
    if (dataInputSchemaPath) {
      workflow.dataInputSchema = dataInputSchemaPath;
    }

    await this.saveFile(definitionsPath, workflow);
    return workflow;
  }

  private async saveFile(path: string, data: any): Promise<void> {
    await fs.writeFile(path, JSON.stringify(data), 'utf8');
  }

  async saveWorkflowDefinitionFromUrl(
    url: string,
  ): Promise<Specification.Workflow> {
    const workflow = await this.fetchWorkflowDefinitionFromUrl(url);
    await this.saveWorkflowDefinition(workflow);
    return workflow;
  }

  async fetchWorkflowDefinitionFromUrl(
    url: string,
  ): Promise<Specification.Workflow> {
    const response = await fetch(url);
    const json = await response.json();
    return json as Specification.Workflow;
  }

  async saveOpenApi(): Promise<void> {
    const path = resolvePackagePath(
      `@backstage/plugin-swf-backend`,
      `${this.resourcesPath}/${actions_open_api_file_path}`,
    );
    const openApi = await this.openApiService.generateOpenApi();
    if (!openApi) {
      return;
    }
    await this.saveFile(path, openApi);
  }

  async saveDataInputSchema(
    workflow: Specification.Workflow,
  ): Promise<string | undefined> {
    const openApi = await this.openApiService.generateOpenApi();
    const dataInputSchema = await this.dataInputSchemaService.generate({
      workflow,
      openApi,
    });

    if (!dataInputSchema) {
      return undefined;
    }

    const workflowDataInputSchemaPath = join(
      schemas_folder,
      dataInputSchema.compositionSchema.fileName,
    );

    dataInputSchema.compositionSchema.jsonSchema = {
      $id: `classpath:/${workflowDataInputSchemaPath}`,
      ...dataInputSchema.compositionSchema.jsonSchema,
    };

    const schemaFiles = [
      dataInputSchema.compositionSchema,
      ...dataInputSchema.actionSchemas,
    ];

    const saveSchemaPromises = schemaFiles.map(schemaFile => {
      const path = resolvePackagePath(
        `@backstage/plugin-swf-backend`,
        join(this.resourcesPath, schemas_folder, schemaFile.fileName),
      );
      return this.saveFile(path, schemaFile.jsonSchema);
    });

    await Promise.all(saveSchemaPromises);

    return workflowDataInputSchemaPath;
  }

  async deleteWorkflowDefinitionById(swfId: string): Promise<void> {
    const definitionsPath = resolvePackagePath(
      `@backstage/plugin-swf-backend`,
      `${this.resourcesPath}/${swfId}.sw.json`,
    );
    await fs.rm(definitionsPath, { force: true });
  }
}
