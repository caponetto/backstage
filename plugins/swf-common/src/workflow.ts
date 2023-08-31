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

import { Specification } from '@severlessworkflow/sdk-typescript';
import { SwfDefinition, WorkflowFormat } from './types';
import { dump } from 'js-yaml';

export function fromWorkflowSource(content: string): SwfDefinition {
  const parsed = Specification.Workflow.fromSource(content);
  const workflow = parsed.sourceModel ?? parsed;
  return removeProperty(workflow, 'normalize');
}

export function toWorkflowString(
  definition: SwfDefinition,
  format: WorkflowFormat,
): string {
  switch (format) {
    case 'json':
      return toWorkflowJson(definition);
    case 'yaml':
      return toWorkflowYaml(definition);
    default:
      throw new Error(`Unsupported format ${format}`);
  }
}

export function toWorkflowJson(definition: SwfDefinition): string {
  return JSON.stringify(definition, null, 2);
}

export function toWorkflowYaml(definition: SwfDefinition): string {
  return dump(definition);
}

export function extractWorkflowFormatFromUri(uri: string): WorkflowFormat {
  const match = uri.match(/\.sw\.(json|yaml|yml)$/);
  if (match) {
    if (match[1] === 'yml' || match[1] === 'yaml') {
      return 'yaml';
    }
    if (match[1] === 'json') {
      return 'json';
    }
  }
  throw new Error(`Unsupported workflow format for uri ${uri}`);
}

function removeProperty<T>(obj: T, propToDelete: string): T {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => removeProperty(item, propToDelete)) as T;
  }

  const newObj: any = {};

  for (const key in obj) {
    if (key !== propToDelete) {
      newObj[key] = removeProperty(obj[key], propToDelete); // Recurse into nested objects
    }
  }

  return newObj;
}
