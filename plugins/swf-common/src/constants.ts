/*
 * Copyright 2021 The Backstage Authors
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
export const topic = 'kogito-swf-service-ready';

export const to_be_entered = `<Enter>`;

export const empty_definition = `{
    "id": "${to_be_entered}",
    "version": "1.0",
    "specVersion": "0.8",
    "name": "${to_be_entered}",
    "description": "${to_be_entered}",
    "start": "Stage1",
    "states": [
      {
        "name": "Stage1",
        "type": "operation",
        "actions": [],
        "end": true
      }
    ]
  }
  `;

export const actions_open_api_file = 'actions-openapi.json';
export const actions_open_api_file_path = `specs/${actions_open_api_file}`;

export const schemas_folder = 'schemas';

export const workflow_title = 'Workflow';
export const workflow_title_plural = 'Workflows';
export const workflow_type = 'workflow';
