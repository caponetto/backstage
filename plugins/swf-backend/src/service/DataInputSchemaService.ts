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

type OpenApiSchemaProperties = {
  [k: string]: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject;
};

interface WorkflowFunctionArgs {
  [x: string]: any;
}

interface WorkflowActionDescriptor {
  descriptor: string;
  action: Specification.Action;
}

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
  VALUES_IN_SKELETON:
    /\{\{[%-]?\s*values\.(\w+)\s*[%-]?}}|\{%-?\s*if\s*values\.(\w+)\s*(?:%-?})?/gi,
  GITHUB_URL:
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/(.+)$/,
  GITHUB_API_URL:
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)\?ref=(.+)$/,
  NAIVE_ARG_IN_JQ: /^\$\{[^}]*}$|^(\.[^\s.{]+)(?!\.)$/,
  NON_ALPHA_NUMERIC: /[^a-zA-Z0-9]+/g,
  SNAKE_CASE: /_([a-z])/g,
  CAMEL_CASE: /([A-Z])/g,
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
    const functionActionMap = this.extractFunctionActionMap(args.workflow);

    const actionSchemas: JsonSchemaFile[] = [];

    for (const [fnName, workflowActionsUsingFn] of functionActionMap) {
      const operationId = this.extractOperationIdByWorkflowFunctionName({
        workflow: args.workflow,
        functionName: fnName,
      });
      if (!operationId) {
        this.logger.info(
          `No operation id found for function ${fnName}. Skipping...`,
        );
        continue;
      }

      const refSchema = this.extractSchemaByOperationId({
        openApi: args.openApi,
        operationId,
      });
      if (!refSchema) {
        this.logger.info(
          `The schema associated with ${operationId} could not be found. Skipping...`,
        );
        continue;
      }

      const workflowArgsMap = new Map<string, string>();

      for (const actionDescriptor of workflowActionsUsingFn) {
        const functionRefArgs = (
          actionDescriptor.action.functionRef as Specification.Functionref
        ).arguments;
        if (!functionRefArgs) {
          continue;
        }

        const schemaPropsToFilter = { ...(refSchema.properties ?? {}) };
        const workflowArgsToFilter = {
          ...functionRefArgs,
        } as WorkflowFunctionArgs;

        if (operationId === FETCH_TEMPLATE_ACTION_OPERATION_ID) {
          const skeletonValues = await this.extractTemplateValuesFromSkeleton(
            workflowArgsToFilter,
          );

          if (!skeletonValues) {
            continue;
          }

          skeletonValues.forEach(v => {
            schemaPropsToFilter[v] = {
              title: v,
              description: `Extracted from ${workflowArgsToFilter.url}`,
              type: 'string',
            };
            schemaPropsToFilter[this.snakeCaseToCamelCase(v)] = {
              title: this.snakeCaseToCamelCase(v),
              description: `Extracted from ${workflowArgsToFilter.url}`,
              type: 'string',
            };
            schemaPropsToFilter[this.camelCaseToSnakeCase(v)] = {
              title: this.camelCaseToSnakeCase(v),
              description: `Extracted from ${workflowArgsToFilter.url}`,
              type: 'string',
            };
          });

          Object.keys(workflowArgsToFilter.values).forEach(k => {
            workflowArgsToFilter[k] = workflowArgsToFilter.values[k];
          });
        }

        if (refSchema.oneOf?.length) {
          const oneOfSchema = (
            refSchema.oneOf as OpenAPIV3.SchemaObject[]
          ).find(item =>
            Object.keys(workflowArgsToFilter).some(arg =>
              Object.keys(item.properties!).includes(arg),
            ),
          );
          if (!oneOfSchema?.properties) {
            continue;
          }
          Object.entries(oneOfSchema.properties).forEach(([k, v]) => {
            schemaPropsToFilter[k] = {
              ...(v as OpenAPIV3.BaseSchemaObject),
            };
          });
        }

        const requiredArgsToShow =
          this.extractRequiredArgsToShow(workflowArgsToFilter);
        if (!Object.keys(requiredArgsToShow).length) {
          continue;
        }

        const filteredProperties: OpenApiSchemaProperties = {};
        const filteredRequired: string[] = [];
        for (const [argKey, argValue] of Object.entries(requiredArgsToShow)) {
          if (!schemaPropsToFilter.hasOwnProperty(argKey)) {
            continue;
          }
          let argId;
          if (workflowArgsMap.has(argKey)) {
            if (workflowArgsMap.get(argKey) === argValue) {
              continue;
            }
            argId = this.sanitizeText({
              text: `${actionDescriptor.descriptor} ${argKey}`,
              placeholder: '_',
            });
          } else {
            argId = argKey;
          }
          workflowArgsMap.set(argId, argValue);

          filteredProperties[argId] = {
            ...schemaPropsToFilter[argKey],
          };
          filteredRequired.push(argKey);
        }

        const updatedSchema = {
          properties: Object.keys(filteredProperties).length
            ? { ...filteredProperties }
            : undefined,
          required: filteredRequired.length ? [...filteredRequired] : undefined,
        };

        if (!updatedSchema.properties) {
          continue;
        }

        const actionSchema = this.buildJsonSchemaSkeleton({
          workflowId: args.workflow.id,
          title: actionDescriptor.descriptor,
          filename: this.sanitizeText({
            text: actionDescriptor.descriptor,
            placeholder: '_',
          }),
        });

        actionSchema.jsonSchema = {
          ...actionSchema.jsonSchema,
          ...updatedSchema,
        };
        actionSchemas.push(actionSchema);
      }
    }

    if (!actionSchemas.length) {
      return null;
    }

    const compositionSchema = this.buildJsonSchemaSkeleton({
      workflowId: args.workflow.id,
      filename: `${args.workflow.id}`,
      title: `Data Input Schema - ${args.workflow.name ?? args.workflow.id}`,
    });

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

  private async extractTemplateValuesFromSkeleton(
    workflowArgs: WorkflowFunctionArgs,
  ): Promise<string[] | undefined> {
    if (
      !workflowArgs.url ||
      !workflowArgs.values ||
      !Object.keys(workflowArgs.values).length
    ) {
      return undefined;
    }
    const githubPath = this.convertToGitHubApiUrl(workflowArgs.url.trim());
    if (!githubPath) {
      return undefined;
    }
    // This call can be expensive
    return await this.extractTemplateValuesFromSkeletonUrl(githubPath);
  }

  private extractRequiredArgsToShow(
    argsToFilter: WorkflowFunctionArgs,
  ): WorkflowFunctionArgs {
    return Object.entries(argsToFilter).reduce((obj, [k, v]) => {
      if (
        typeof v === 'string' &&
        Regex.NAIVE_ARG_IN_JQ.test(String(v.trim()))
      ) {
        obj[k] = v;
      }
      return obj;
    }, {} as WorkflowFunctionArgs);
  }

  private extractSchemaByOperationId(args: {
    openApi: OpenAPIV3.Document;
    operationId: string;
  }): OpenAPIV3.SchemaObject | undefined {
    const openApiOperation = this.extractOperationFromOpenApi({
      openApi: args.openApi,
      operationId: args.operationId,
    });
    if (!openApiOperation?.requestBody) {
      this.logger.info(
        `The operation associated with ${args.operationId} has no requestBody.`,
      );
      return undefined;
    }

    const requestBodyContent = (
      openApiOperation.requestBody as OpenAPIV3.RequestBodyObject
    ).content;
    if (!requestBodyContent) {
      this.logger.info(
        `The request body associated with ${args.operationId} has no content.`,
      );
      return undefined;
    }

    const bodyContent = Object.values(requestBodyContent).pop();
    if (!bodyContent?.schema) {
      this.logger.info(
        `The body content associated with ${args.operationId} has no schema.`,
      );
      return undefined;
    }

    const $ref = (bodyContent.schema as OpenAPIV3.ReferenceObject).$ref;
    if (!$ref) {
      this.logger.info(
        `The schema associated with ${args.operationId} has no $ref.`,
      );
      return undefined;
    }

    const refParts = $ref.split('/');
    const refKey = refParts[refParts.length - 1];
    return args.openApi.components?.schemas?.[refKey] as OpenAPIV3.SchemaObject;
  }

  private extractFunctionActionMap(
    workflow: Specification.Workflow,
  ): Map<string, WorkflowActionDescriptor[]> {
    if (!Array.isArray(workflow.functions)) {
      return new Map();
    }

    return new Map(
      workflow.functions.map(fn => {
        const descriptors = this.extractActionsUsingFunction({
          workflow,
          functionRefName: fn.name,
        });
        return [fn.name, descriptors];
      }),
    );
  }

  private extractActionsUsingFunction(args: {
    workflow: Specification.Workflow;
    functionRefName: string;
  }): WorkflowActionDescriptor[] {
    const descriptors: WorkflowActionDescriptor[] = [];
    for (const state of args.workflow.states) {
      if (state.type === 'operation') {
        descriptors.push(
          ...this.extractActionsFromOperationStateByFunctionRefName({
            state,
            functionRefName: args.functionRefName,
          }),
        );
      } else if (state.type === 'parallel') {
        descriptors.push(
          ...this.extractActionsFromParallelStateByFunctionRefName({
            state,
            functionRefName: args.functionRefName,
          }),
        );
      } else if (state.type === 'foreach') {
        descriptors.push(
          ...this.extractActionsFromForeachStateByFunctionRefName({
            state,
            functionRefName: args.functionRefName,
          }),
        );
      } else if (state.type === 'event') {
        descriptors.push(
          ...this.extractActionsFromEventStateByFunctionRefName({
            state,
            functionRefName: args.functionRefName,
          }),
        );
      } else if (state.type === 'callback') {
        descriptors.push(
          ...this.extractActionsFromCallbackStateByFunctionRefName({
            state,
            functionRefName: args.functionRefName,
          }),
        );
      }
    }
    return descriptors;
  }

  private buildActionDescriptor(args: {
    actionName?: string;
    stateName: string;
    functionRefName: string;
    outerItem?:
      | { name: string } & (
          | { kind: 'Unique' }
          | {
              kind: 'Array';
              array: Specification.Onevents[] | Specification.Branch[];
              idx: number;
            }
        );
    actions?: {
      array: Specification.Action[];
      idx: number;
    };
  }): string {
    const separator = ' > ';
    let descriptor = `${args.stateName}`;
    if (args.outerItem) {
      if (args.outerItem.kind === 'Unique') {
        descriptor += `${separator}${args.outerItem.name}`;
      } else if (args.outerItem.array.length > 1) {
        descriptor += `${separator}${args.outerItem.name}-${
          args.outerItem.idx + 1
        }`;
      }
    }
    if (args.actionName) {
      descriptor += `${separator}${args.actionName}`;
    }
    descriptor += `${separator}${args.functionRefName}`;
    if (!args.actionName && args.actions && args.actions.array.length > 1) {
      descriptor += `${separator}${args.actions.idx + 1}`;
    }
    return descriptor;
  }

  private extractActionsFromOperationStateByFunctionRefName(args: {
    state: Specification.Operationstate;
    functionRefName: string;
  }): WorkflowActionDescriptor[] {
    if (!args.state.actions) {
      return [];
    }
    return args.state.actions
      .filter(
        action =>
          (action.functionRef as Specification.Functionref)?.refName ===
          args.functionRefName,
      )
      .map<WorkflowActionDescriptor>((action, idx, arr) => {
        const descriptor = this.buildActionDescriptor({
          actionName: action.name,
          stateName: args.state.name!,
          functionRefName: args.functionRefName,
          actions: {
            array: arr,
            idx,
          },
        });
        return { descriptor, action };
      });
  }

  private extractActionsFromParallelStateByFunctionRefName(args: {
    state: Specification.Parallelstate;
    functionRefName: string;
  }): WorkflowActionDescriptor[] {
    if (!args.state.branches) {
      return [];
    }

    return args.state.branches
      .map(branch =>
        branch.actions
          .filter(
            action =>
              (action.functionRef as Specification.Functionref)?.refName ===
              args.functionRefName,
          )
          .map<WorkflowActionDescriptor>((action, idx, arr) => {
            const descriptor = this.buildActionDescriptor({
              actionName: action.name,
              outerItem: {
                kind: 'Unique',
                name: branch.name,
              },
              stateName: args.state.name!,
              functionRefName: args.functionRefName,
              actions: {
                array: arr,
                idx,
              },
            });
            return { descriptor, action };
          }),
      )
      .flat();
  }

  private extractActionsFromForeachStateByFunctionRefName(args: {
    state: Specification.Foreachstate;
    functionRefName: string;
  }): WorkflowActionDescriptor[] {
    if (!args.state.actions) {
      return [];
    }
    return args.state.actions
      .filter(
        a =>
          (a.functionRef as Specification.Functionref)?.refName ===
          args.functionRefName,
      )
      .map<WorkflowActionDescriptor>((action, idx, arr) => {
        const descriptor = this.buildActionDescriptor({
          actionName: action.name,
          stateName: args.state.name!,
          functionRefName: args.functionRefName,
          actions: {
            array: arr,
            idx,
          },
        });
        return { descriptor, action };
      });
  }

  private extractActionsFromEventStateByFunctionRefName(args: {
    state: Specification.Eventstate;
    functionRefName: string;
  }): WorkflowActionDescriptor[] {
    if (!args.state.onEvents) {
      return [];
    }

    return args.state.onEvents
      .map((onEvent, eIdx, eArr) => {
        if (!onEvent.actions) {
          return [];
        }
        return onEvent.actions
          .filter(
            action =>
              (action.functionRef as Specification.Functionref)?.refName ===
              args.functionRefName,
          )
          .map<WorkflowActionDescriptor>((action, aIdx, aArr) => {
            const descriptor = this.buildActionDescriptor({
              actionName: action.name,
              stateName: args.state.name!,
              functionRefName: args.functionRefName,
              actions: {
                array: aArr,
                idx: aIdx,
              },
              outerItem: {
                kind: 'Array',
                name: 'onEvent',
                array: eArr,
                idx: eIdx,
              },
            });
            return { descriptor, action };
          });
      })
      .flat();
  }

  private extractActionsFromCallbackStateByFunctionRefName(args: {
    state: Specification.Callbackstate;
    functionRefName: string;
  }): WorkflowActionDescriptor[] {
    if (!args.state.action) {
      return [];
    }

    const refName = (args.state.action.functionRef as Specification.Functionref)
      ?.refName;

    if (refName !== args.functionRefName) {
      return [];
    }

    const descriptor = this.buildActionDescriptor({
      actionName: args.state.action.name,
      stateName: args.state.name!,
      functionRefName: args.functionRefName,
    });

    return [{ descriptor, action: args.state.action }];
  }

  private snakeCaseToCamelCase(input: string): string {
    return input.replace(Regex.SNAKE_CASE, (_, letter) => letter.toUpperCase());
  }

  private camelCaseToSnakeCase(input: string): string {
    return input.replace(
      Regex.CAMEL_CASE,
      (_, letter) => `_${letter.toLowerCase()}`,
    );
  }

  private sanitizeText(args: { text: string; placeholder: string }): string {
    const parts = args.text.trim().split(Regex.NON_ALPHA_NUMERIC);
    return parts.join(args.placeholder);
  }

  private buildJsonSchemaSkeleton(args: {
    workflowId: string;
    title: string;
    filename: string;
  }): JsonSchemaFile {
    return {
      fileName: `${args.workflowId}__schema__${args.filename}.json`,
      jsonSchema: {
        title: args.title,
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

  private extractOperationIdByWorkflowFunctionName(args: {
    workflow: Specification.Workflow;
    functionName: string;
  }): string | undefined {
    if (!Array.isArray(args.workflow.functions)) {
      return undefined;
    }

    const workflowFunction = args.workflow.functions.find(
      f => f.name === args.functionName,
    );

    if (!workflowFunction) {
      return undefined;
    }

    return this.extractOperationIdFromWorkflowFunction(workflowFunction);
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

  private async extractTemplateValuesFromSkeletonUrl(
    githubPath: GitHubPath,
  ): Promise<string[]> {
    try {
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
    } catch (e) {
      this.logger.error(e);
    }
    return [];
  }

  private async extractTemplateValuesFromGitHubFile(
    githubPath: GitHubPath,
  ): Promise<string[]> {
    const matchesInPath = githubPath.path.matchAll(Regex.VALUES_IN_SKELETON);
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
      const matchesInContent = fileContent.matchAll(Regex.VALUES_IN_SKELETON);
      const valuesInContent = Array.from(
        matchesInContent,
        match => match[1] || match[2],
      );
      return [...valuesInPath, ...valuesInContent];
    } catch (e) {
      this.logger.error(e);
    }
    return [];
  }
}
