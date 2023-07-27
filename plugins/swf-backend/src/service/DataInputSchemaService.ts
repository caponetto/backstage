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
import { Octokit } from '@octokit/rest';

type SchemaProperties = {
  [k: string]: JSONSchema4;
};

interface GitHubPath {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

interface GitTreeItem {
  path: string;
  type: 'blob' | 'tree';
}

interface FileData {
  content: string;
  encoding: BufferEncoding;
}

interface JsonSchemaFile {
  fileName: string;
  jsonSchema: JSONSchema4;
}

interface ComposedJsonSchema {
  compositionSchema: JsonSchemaFile;
  actionSchemas: JsonSchemaFile[];
}

const JSON_SCHEMA_VERSION = 'http://json-schema.org/draft-04/schema#';
const FETCH_TEMPLATE_ACTION_OPERATION_ID = 'fetch:template';

const Regex = {
  SKELETON_VALUES: /\{\{\s*values\.(\w+)\s*\}\}/gi,
  GITHUB_URL:
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/(.+)$/,
  GITHUB_API_URL:
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)\?ref=(.+)$/,
} as const;

export class DataInputSchemaService {
  private readonly octokit: Octokit;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly logger: Logger,
    githubToken: string | undefined,
  ) {
    this.octokit = new Octokit({ auth: githubToken });
  }

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

    const templateSchemaPromises: Promise<JsonSchemaFile[]>[] = [];

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
        templateSchemaPromises.push(
          this.resolveSchemasFromTemplates({
            workflow: args.workflow,
            functionName: fn.name,
          }),
        );
      }
    }

    const templateSchemas = await Promise.all(templateSchemaPromises);
    actionSchemas.push(...templateSchemas.flat());

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
    const pathMap = this.resolveGitHubPathMapForTemplates({
      workflow: args.workflow,
      functionName: args.functionName,
    });
    if (!pathMap.size) {
      return [];
    }

    const inputValuesMap = await this.resolveInputValues(pathMap);

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

  private resolveGitHubPathMapForTemplates(args: {
    workflow: Specification.Workflow;
    functionName: string;
  }): Map<string, GitHubPath> {
    const pathMap = new Map<string, GitHubPath>();
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
      if (!action) {
        continue;
      }
      const functionRef = action.functionRef as Specification.Functionref;
      if (!functionRef.arguments?.url) {
        continue;
      }
      const templateName =
        action.name ?? operationState.name ?? functionRef.refName;
      const githubPath = this.convertToGitHubApiUrl(functionRef.arguments.url);
      if (!githubPath) {
        continue;
      }
      pathMap.set(templateName, githubPath);
    }
    return pathMap;
  }

  private removeTrailingSlash(path: string): string {
    if (path.endsWith('/')) {
      return path.slice(0, -1);
    }
    return path;
  }

  private convertToGitHubApiUrl(githubUrl: string): GitHubPath | undefined {
    const githubApiMatch = githubUrl.match(Regex.GITHUB_API_URL);
    if (githubApiMatch) {
      const [, owner, repo, ref, path] = githubApiMatch;
      return {
        owner,
        repo,
        ref,
        path: this.removeTrailingSlash(path),
      };
    }

    const githubUrlMatch = githubUrl.match(Regex.GITHUB_URL);
    if (!githubUrlMatch) {
      return undefined;
    }

    const [, owner, repo, ref, path] = githubUrlMatch;
    return {
      owner,
      repo,
      ref,
      path: this.removeTrailingSlash(path),
    };
  }

  private async resolveInputValues(
    githubPathMap: Map<string, GitHubPath>,
  ): Promise<Map<string, string[]>> {
    const valuesMap = new Map();
    for (const [name, githubPath] of githubPathMap) {
      try {
        const values = await this.extractTemplateValuesFromSkeleton(githubPath);
        valuesMap.set(name, values);
      } catch (e) {
        this.logger.error(e);
      }
    }
    return valuesMap;
  }

  private async fetchGitHubFilePaths(repoInfo: GitHubPath): Promise<string[]> {
    const response = await this.octokit.request(
      'GET /repos/:owner/:repo/git/trees/:ref',
      {
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        ref: repoInfo.ref,
        recursive: 1,
      },
    );
    return response.data.tree
      .filter((item: GitTreeItem) => item.type === 'blob')
      .map((item: GitTreeItem) => item.path)
      .filter((path: string) => path.startsWith(`${repoInfo.path}/`));
  }

  private async extractTemplateValuesFromSkeleton(
    githubPath: GitHubPath,
  ): Promise<string[]> {
    const filePaths = await this.fetchGitHubFilePaths(githubPath);
    const fileMatchPromises: Promise<string[]>[] = [];

    filePaths.forEach(p => {
      fileMatchPromises.push(
        this.extractTemplateValuesFromGitHubFile({
          ...githubPath,
          path: p,
        }),
      );
    });

    const fileMatches = (await Promise.all(fileMatchPromises))
      .flat()
      .filter((r): r is string => r !== undefined);

    return Array.from(new Set(fileMatches));
  }

  private async extractTemplateValuesFromGitHubFile(
    githubPath: GitHubPath,
  ): Promise<string[]> {
    const matchesInPath = githubPath.path.matchAll(Regex.SKELETON_VALUES);
    const valuesInPath = Array.from(matchesInPath, match => match[1]);

    try {
      const content = await this.octokit.repos.getContent({ ...githubPath });
      if (!content) {
        return [];
      }
      const fileData = content.data as FileData;
      const fileContent = this.decoder.decode(
        new Uint8Array(Buffer.from(fileData.content, fileData.encoding)),
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
