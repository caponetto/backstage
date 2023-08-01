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
import React, { useCallback, useState } from 'react';
import { Grid } from '@material-ui/core';
import {
  Content,
  ContentHeader,
  Header,
  HeaderLabel,
  InfoCard,
  Page,
  Progress,
  SupportButton,
} from '@backstage/core-components';
import { SWFEditor } from '../SWFEditor';
import { useController } from '@kie-tools-core/react-hooks/dist/useController';
import { EditorViewKind, SWFEditorRef } from '../SWFEditor/SWFEditor';
import Button from '@material-ui/core/Button';
import Typography from '@material-ui/core/Typography';
import { swfApiRef } from '../../api';
import {
  alertApiRef,
  errorApiRef,
  useApi,
  useRouteRef,
  useRouteRefParams,
} from '@backstage/core-plugin-api';
import { useNavigate } from 'react-router-dom';
import { definitionsRouteRef, editWorkflowRouteRef } from '../../routes';
import { to_be_entered, workflow_title } from '@backstage/plugin-swf-common';
import { Specification } from '@severlessworkflow/sdk-typescript';

export const CreateSWFPage = () => {
  const swfId = useRouteRefParams(editWorkflowRouteRef).swfId;
  const [swfEditor, swfEditorRef] = useController<SWFEditorRef>();
  const errorApi = useApi(errorApiRef);
  const alertApi = useApi(alertApiRef);
  const swfApi = useApi(swfApiRef);
  const navigate = useNavigate();
  const definitionLink = useRouteRef(definitionsRouteRef);
  const [loading, setLoading] = useState(false);

  const handleResult = useCallback(
    async (content: string) => {
      try {
        // Check basic details have been entered
        const workflow = Specification.Workflow.fromSource(content);
        if (workflow.id === to_be_entered) {
          errorApi.post(new Error(`The 'id' must be entered.`));
          return;
        }
        if (workflow.name === to_be_entered) {
          errorApi.post(new Error(`The 'name' must be entered.`));
          return;
        }
        if (workflow.description === to_be_entered) {
          errorApi.post(new Error(`The 'description' must be entered.`));
          return;
        }

        // Check validate as provided by the Stunner editor
        swfEditor?.validate().then(n => {
          if (!n) {
            errorApi.post(new Error('Error creating workflow'));
            return;
          }
          if (n.length !== 0) {
            errorApi.post(
              new Error(
                `Error creating workflow: ${JSON.stringify(n, undefined, 2)}`,
              ),
            );
            return;
          }

          setLoading(true);

          // Try to save
          swfApi
            .createWorkflowDefinition('', content)
            .then(swf => {
              if (!swf?.id) {
                errorApi.post(new Error('Error creating workflow'));
              } else {
                alertApi.post({
                  severity: 'info',
                  message: `Workflow ${swf.id} has been saved.`,
                });
                navigate(definitionLink({ swfId: swf.id }));
              }
            })
            .finally(() => setLoading(false));
        });
      } catch (e: any) {
        errorApi.post(new Error(e));
        setLoading(false);
      }
    },
    [swfEditor, errorApi, swfApi, alertApi, navigate, definitionLink],
  );

  return (
    <Page themeId="tool">
      <Header
        title={workflow_title}
        subtitle={`Where all your ${workflow_title} needs come to life!`}
      >
        <HeaderLabel label="Owner" value="Team X" />
        <HeaderLabel label="Lifecycle" value="Alpha" />
      </Header>
      <Content>
        <ContentHeader title={workflow_title}>
          <SupportButton>Orchestrate things with stuff.</SupportButton>
        </ContentHeader>
        <Grid container spacing={3} direction="column">
          <Grid item>
            {loading && <Progress />}
            <InfoCard
              title={
                <>
                  <Typography variant="h5">
                    Author - Example of how we could support authoring
                  </Typography>
                  <Button
                    color="primary"
                    type="submit"
                    variant="contained"
                    disabled={loading}
                    onClick={() => {
                      swfEditor?.getContent().then(content => {
                        if (content) {
                          handleResult(content);
                        }
                      });
                    }}
                  >
                    Save...
                  </Button>
                </>
              }
            >
              <div style={{ height: '500px', padding: '10px' }}>
                <SWFEditor
                  ref={swfEditorRef}
                  kind={EditorViewKind.AUTHORING}
                  swfId={swfId}
                />
              </div>
            </InfoCard>
          </Grid>
        </Grid>
      </Content>
    </Page>
  );
};
