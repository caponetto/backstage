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

import { Logger } from 'winston';
import { Specification } from '@severlessworkflow/sdk-typescript';
import { OpenAPIV3 } from 'openapi-types';
import { JSONSchema4 } from 'json-schema';

type SchemaProperties = {
  [k: string]: JSONSchema4;
};

interface JsonSchemaFile {
  fileName: string;
  jsonSchema: JSONSchema4;
}

interface ComposedJsonSchema {
  compositionSchema: JsonSchemaFile;
  actionSchemas: JsonSchemaFile[];
}

type GitHubFolderContentItem =
  | { name: string; path: string } & (
      | {
          type: 'file';
          download_url: string;
        }
      | {
          type: 'dir';
          url: string;
        }
    );

const JSON_SCHEMA_VERSION = 'http://json-schema.org/draft-04/schema#';
const FETCH_TEMPLATE_ACTION_OPERATION_ID = 'fetch:template';

const Regex = {
  SKELETON_VALUES: /\{\{\s*values\.(\w+)\s*\}\}/gi,
  GITHUB_URL: /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/,
  GITHUB_API_URL:
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)\?ref=(.+)$/,
} as const;

export class DataInputSchemaService {
  constructor(
    private readonly logger: Logger,
    private readonly githubToken: string | undefined,
  ) {}

  public async generate(args: {
    workflow: Specification.Workflow;
    openApi: OpenAPIV3.Document;
  }): Promise<ComposedJsonSchema | null> {
    if (!args.workflow.functions?.length) {
      this.logger.info('The workflow has no functions. Skipping generation...');
      return null;
    }

    if (typeof args.workflow.functions === 'string') {
      this.logger.info('Functions cannot be string. Skipping generation...');
      return null;
    }

    const compositionTitle = args.workflow.name
      ? `Data Input Schema for ${args.workflow.name}`
      : 'Data Input Schema';

    const compositionSchema = this.buildSkeleton(compositionTitle);

    const actionSchemas: JsonSchemaFile[] = [];

    for (const fn of args.workflow.functions) {
      const operationId = this.extractOperationIdFromWorkflowFunction(fn);
      if (!operationId) {
        this.logger.info(
          `No operation id found for function ${fn.name}. Skipping...`,
        );
        continue;
      }

      const openApiOperation = this.extractOperationFromOpenApi({
        openApi: args.openApi,
        operationId,
      });
      if (!openApiOperation?.requestBody) {
        this.logger.info(
          `The operation associated with ${operationId} has no requestBody. Skipping...`,
        );
        continue;
      }

      const requestBodyContent = (
        openApiOperation.requestBody as OpenAPIV3.RequestBodyObject
      ).content;
      if (!requestBodyContent) {
        this.logger.info(
          `The request body associated with ${operationId} has no content. Skipping...`,
        );
        continue;
      }

      const bodyContent = Object.values(requestBodyContent).pop();
      if (!bodyContent?.schema) {
        this.logger.info(
          `The body content associated with ${operationId} has no schema. Skipping...`,
        );
        continue;
      }

      const $ref = (bodyContent.schema as OpenAPIV3.ReferenceObject).$ref;
      if (!$ref) {
        this.logger.info(
          `The schema associated with ${operationId} has no $ref. Skipping...`,
        );
        continue;
      }

      const refKey = $ref.replace('#/components/schemas/', '');
      const referencedSchema = args.openApi.components?.schemas?.[
        refKey
      ] as OpenAPIV3.SchemaObject;

      if (!referencedSchema) {
        this.logger.info(
          `The ref ${refKey} could not be found for ${operationId}. Skipping...`,
        );
        continue;
      }

      const actionSchema = this.buildSkeleton(operationId);
      actionSchema.jsonSchema = {
        ...actionSchema.jsonSchema,
        ...referencedSchema,
      };
      actionSchemas.push(actionSchema);

      if (operationId === FETCH_TEMPLATE_ACTION_OPERATION_ID) {
        const templateSchemas = await this.resolveSchemasFromTemplates({
          workflow: args.workflow,
          functionName: fn.name,
        });
        actionSchemas.push(...templateSchemas);
      }
    }

    actionSchemas.forEach(actionSchema => {
      compositionSchema.jsonSchema.properties = {
        ...compositionSchema.jsonSchema.properties,
        [`${actionSchema.jsonSchema.title}`]: {
          $ref: actionSchema.fileName,
          type: actionSchema.jsonSchema.type,
          description: actionSchema.jsonSchema.description,
        },
      };
    });

    return { compositionSchema, actionSchemas };
  }

  private async resolveSchemasFromTemplates(args: {
    workflow: Specification.Workflow;
    functionName: string;
  }): Promise<JsonSchemaFile[]> {
    const templateUrlMap = this.resolveGitHubApiUrlMapForTemplates({
      workflow: args.workflow,
      functionName: args.functionName,
    });
    if (!templateUrlMap.size) {
      return [];
    }

    const inputValuesMap = await this.resolveInputValues(templateUrlMap);

    return Array.from(inputValuesMap)
      .filter(([_, values]) => values.length)
      .map(([name, values]) => {
        const templateProperties = values.reduce(
          (result: SchemaProperties, key: string) => {
            result[`${key}`] = {
              title: key,
              description: key,
              type: 'string',
            };
            return result;
          },
          {},
        );

        const templateSchema = this.buildSkeleton(name);
        templateSchema.jsonSchema.properties = {
          ...templateSchema.jsonSchema.properties,
          ...templateProperties,
        };
        return templateSchema;
      });
  }

  private sanitize(args: { text: string; placeholder: string }): string {
    return args.text.replace(/[^a-zA-Z0-9]/g, args.placeholder).toLowerCase();
  }

  private buildSkeleton(title: string): JsonSchemaFile {
    const fileName = `${this.sanitize({ text: title, placeholder: '_' })}.json`;
    return {
      fileName,
      jsonSchema: {
        title: title,
        $schema: JSON_SCHEMA_VERSION,
        type: 'object',
        properties: {},
      },
    };
  }

  private extractOperationIdFromWorkflowFunction(
    workflowFunction: Specification.Function,
  ): string {
    return workflowFunction.operation.split('#')[1];
  }

  private extractOperationFromOpenApi(args: {
    openApi: OpenAPIV3.Document;
    operationId: string;
  }): OpenAPIV3.OperationObject | undefined {
    return Object.values(args.openApi.paths)
      .flatMap(
        methods =>
          methods &&
          Object.values(methods).filter(
            method =>
              method &&
              (method as OpenAPIV3.OperationObject).operationId ===
                args.operationId,
          ),
      )
      .pop() as OpenAPIV3.OperationObject | undefined;
  }

  private resolveGitHubApiUrlMapForTemplates(args: {
    workflow: Specification.Workflow;
    functionName: string;
  }): Map<string, string> {
    const urlMap = new Map();
    for (const state of args.workflow.states) {
      const operationState = state as Specification.Operationstate;
      if (!operationState.actions?.length) {
        continue;
      }
      const action = operationState.actions.find(
        a =>
          (a.functionRef as Specification.Functionref)?.refName ===
          args.functionName,
      );
      if (!action?.name) {
        continue;
      }
      const functionRef = action.functionRef as Specification.Functionref;
      if (!functionRef.arguments?.url) {
        continue;
      }
      const githubApiUrl = this.convertToGitHubApiUrl(
        functionRef.arguments.url,
      );
      if (!githubApiUrl) {
        continue;
      }
      urlMap.set(action.name, githubApiUrl);
    }
    return urlMap;
  }

  private convertToGitHubApiUrl(githubUrl: string): string | undefined {
    const githubApiMatch = githubUrl.match(Regex.GITHUB_API_URL);
    if (githubApiMatch) {
      return githubUrl;
    }

    const githubUrlMatch = githubUrl.match(Regex.GITHUB_URL);
    if (!githubUrlMatch) {
      return undefined;
    }

    const [, org, repo, branch, path] = githubUrlMatch;
    return `https://api.github.com/repos/${org}/${repo}/contents/${path}?ref=${branch}`;
  }

  private async resolveInputValues(
    urlMap: Map<string, string>,
  ): Promise<Map<string, string[]>> {
    const valuesMap = new Map();
    for (const [name, url] of urlMap) {
      try {
        const values = await this.extractTemplateValuesFromSkeleton(url);
        valuesMap.set(name, values);
      } catch (e) {
        this.logger.error(e);
      }
    }
    return valuesMap;
  }

  private async fetchGitHub(url: string): Promise<Response> {
    return fetch(url, {
      headers: this.githubToken
        ? {
            Authorization: `Bearer ${this.githubToken}`,
          }
        : undefined,
    });
  }

  private async fetchGitHubFolderContent(
    githubUrl: string,
  ): Promise<GitHubFolderContentItem[]> {
    const response = await this.fetchGitHub(githubUrl);
    return await response.json();
  }

  private async fetchGitHubFileContent(fileUrl: string): Promise<string> {
    const response = await this.fetchGitHub(fileUrl);
    return await response.text();
  }

  private async extractTemplateValuesFromSkeleton(
    githubUrl: string,
  ): Promise<string[]> {
    const stack: string[] = [githubUrl];
    const fileMatchPromises: Promise<string[]>[] = [];

    while (stack.length > 0) {
      const currentUrl = stack.pop();
      if (!currentUrl) {
        continue;
      }

      const folderContent = await this.fetchGitHubFolderContent(currentUrl);
      folderContent.forEach(content => {
        if (content.type === 'file') {
          fileMatchPromises.push(
            this.extractTemplateValuesFromGitHubFile(content),
          );
        } else if (content.type === 'dir') {
          // TODO: nested folders make this code slower
          stack.push(content.url);
        }
      });
    }

    const fileMatches = (await Promise.all(fileMatchPromises))
      .flat()
      .filter((r): r is string => r !== undefined);

    return Array.from(new Set(fileMatches));
  }

  private async extractTemplateValuesFromGitHubFile(
    content: GitHubFolderContentItem,
  ): Promise<string[]> {
    if (content.type !== 'file') {
      return [];
    }

    const matchesInPath = content.path.matchAll(Regex.SKELETON_VALUES);
    const valuesInPath = Array.from(matchesInPath, match => match[1]);

    try {
      const fileContent = await this.fetchGitHubFileContent(
        content.download_url,
      );
      const matchesInContent = fileContent.matchAll(Regex.SKELETON_VALUES);
      const valuesInContent = Array.from(matchesInContent, match => match[1]);
      return [...valuesInPath, ...valuesInContent];
    } catch (e) {
      this.logger.error(e);
    }
    return [];
  }
}
