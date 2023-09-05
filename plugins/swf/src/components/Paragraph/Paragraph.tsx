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

import { Typography } from '@material-ui/core';
import { Variant } from '@material-ui/core/styles/createTypography';
import React, { PropsWithChildren } from 'react';

export const Paragraph = (
  props: PropsWithChildren<{ variant?: Variant | 'inherit' }>,
) => {
  return (
    <Typography
      style={{ marginTop: '14px', marginBottom: '14px' }}
      variant={props.variant ?? 'body2'}
      component="p"
    >
      {props.children}
    </Typography>
  );
};
