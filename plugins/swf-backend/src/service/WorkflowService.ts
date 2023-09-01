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
  SwfItem,
  actions_open_api_file_path,
  schemas_folder,
  toWorkflowString,
  fromWorkflowSource,
  extractWorkflowFormatFromUri,
  SwfSpecFile,
  spec_files,
} from '@backstage/plugin-swf-common';
import { DataInputSchemaService } from './DataInputSchemaService';
import { join, extname } from 'path';

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

  async saveWorkflowDefinition(item: SwfItem): Promise<SwfItem> {
    const workflowFormat = extractWorkflowFormatFromUri(item.uri);
    const definitionsPath = resolvePackagePath(
      `@backstage/plugin-swf-backend`,
      `${this.resourcesPath}/${item.definition.id}.sw.${workflowFormat}`,
    );
    const dataInputSchemaPath = await this.saveDataInputSchema(item);
    if (dataInputSchemaPath) {
      item.definition.dataInputSchema = dataInputSchemaPath;
    }

    await this.saveFile(definitionsPath, item.definition);
    return item;
  }

  private async saveFile(path: string, data: any): Promise<void> {
    const fileExtension = extname(path);
    const isWorkflow = /\.sw\.(json|yaml|yml)$/.test(path);
    let contentToSave;
    if (isWorkflow) {
      contentToSave = toWorkflowString(
        data,
        fileExtension === '.json' ? 'json' : 'yaml',
      );
    } else if (fileExtension === '.json') {
      contentToSave = JSON.stringify(data, null, 2);
    } else {
      contentToSave = data;
    }
    await fs.writeFile(path, contentToSave, 'utf8');
  }

  async saveWorkflowDefinitionFromUrl(url: string): Promise<SwfItem> {
    const workflow = await this.fetchWorkflowDefinitionFromUrl(url);
    await this.saveWorkflowDefinition(workflow);
    return workflow;
  }

  async fetchWorkflowDefinitionFromUrl(url: string): Promise<SwfItem> {
    const response = await fetch(url);
    const content = await response.text();
    const definition = fromWorkflowSource(content);
    const urlParts = url.split('/');
    const fileName = urlParts[urlParts.length - 1];
    return {
      uri: fileName,
      definition,
    };
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

  async saveDataInputSchema(swfItem: SwfItem): Promise<string | undefined> {
    const openApi = await this.openApiService.generateOpenApi();
    const dataInputSchema = await this.dataInputSchemaService.generate({
      swfDefinition: swfItem.definition,
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

    dataInputSchema.actionSchemas.forEach(actionSchema => {
      actionSchema.jsonSchema = {
        $id: `classpath:/${schemas_folder}/${actionSchema.fileName}`,
        ...actionSchema.jsonSchema,
      };
    });

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

  async deleteWorkflowDefinitionById(uri: string): Promise<void> {
    const definitionsPath = resolvePackagePath(
      `@backstage/plugin-swf-backend`,
      `${this.resourcesPath}/${uri}`,
    );
    await fs.rm(definitionsPath, { force: true });
  }

  async listStoredSpecs(): Promise<SwfSpecFile[]> {
    const specs: SwfSpecFile[] = [];
    // We can list all spec files from FS but let's keep it simple for now
    for (const relativePath of spec_files) {
      const path = resolvePackagePath(
        `@backstage/plugin-swf-backend`,
        `${this.resourcesPath}/${relativePath}`,
      );
      const buffer = await fs.readFile(path);
      const content = JSON.parse(buffer.toString('utf8'));
      specs.push({ path, content });
    }
    return specs;
  }
}
