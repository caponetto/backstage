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
const path = require('path');
const { merge } = require('webpack-merge');
const common = require('./webpack.common.config');
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const FileManagerPlugin = require('filemanager-webpack-plugin');
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');
const swEditor = require('@kie-tools/serverless-workflow-diagram-editor-assets');
const webpack = require('webpack');

module.exports = () => {
  return [
    merge(common(), {
      entry: {
        'envelope/serverless-workflow-diagram-editor-envelope':
          './envelope/ServerlessWorkflowDiagramEditorEnvelopeApp.ts',
        'envelope/serverless-workflow-combined-editor-envelope':
          './envelope/ServerlessWorkflowCombinedEditorEnvelopeApp.ts',
        'envelope/serverless-workflow-text-editor-envelope':
          './envelope/ServerlessWorkflowTextEditorEnvelopeApp.ts',
      },
      plugins: [
        new webpack.EnvironmentPlugin({
          KOGITO_APP_VERSION: 'DEV',
          KOGITO_APP_NAME: 'Backstage SWF Plugin :: Editor',
        }),
        new CopyPlugin({
          patterns: [
            {
              from: './envelope/serverless-workflow-combined-editor-envelope.html',
              to: './envelope',
            },
            {
              from: './envelope/serverless-workflow-diagram-editor-envelope.html',
              to: './envelope',
            },
            {
              from: './envelope/serverless-workflow-text-editor-envelope.html',
              to: './envelope',
            },
            {
              from: swEditor.swEditorPath(),
              to: './editor',
              globOptions: { ignore: ['**/WEB-INF/**/*'] },
            },
          ],
        }),
        new FileManagerPlugin({
          events: {
            onEnd: {
              mkdir: ['./public/swf/'],
              copy: [
                // Monaco editor configuration
                {
                  source:
                    './dist/vendors-node_modules_monaco-editor_esm_vs_language_json_jsonMode_js.bundle.js',
                  destination: './public/',
                },
                { source: './dist/json.worker.js', destination: './public/' },
                {
                  source: './dist/editor.worker.js',
                  destination: './public/',
                },
                // Stunner editor
                // This needs to be on different paths at the moment as the _Viewer_ is accessed from different web contexts
                { source: './dist/editor', destination: './public/' },
                { source: './dist/editor', destination: './public/diagram' },
                // Kie Tools envelope for Stunner editor
                // This needs to be on different paths at the moment as the _Viewer_ is accessed from different web contexts
                { source: './dist/envelope', destination: './public/' },
                {
                  source: './dist/envelope',
                  destination: './public/swf/items/',
                },
                { source: './dist/fonts', destination: './public/fonts' },
              ],
            },
          },
        }),
        new MonacoWebpackPlugin({
          languages: ['json'],
          customLanguages: [
            {
              label: 'yaml',
              entry: [
                'monaco-yaml',
                'vs/basic-languages/yaml/yaml.contribution',
              ],
              worker: {
                id: 'monaco-yaml/yamlWorker',
                entry: 'monaco-yaml/yaml.worker.js',
              },
            },
          ],
        }),
      ],
      module: {
        rules: [
          {
            test: /\.m?js/,
            resolve: {
              fullySpecified: false,
            },
          },
          {
            test: /\.(tsx|ts)?$/,
            include: [path.resolve(__dirname, 'envelope')],
            use: [
              {
                loader: 'ts-loader',
                options: {
                  configFile: path.resolve('./tsconfig.json'),
                  allowTsInNodeModules: true,
                },
              },
            ],
          },
          {
            test: /\.s[ac]ss$/i,
            use: [
              require.resolve('style-loader'),
              require.resolve('css-loader'),
              require.resolve('sass-loader'),
            ],
          },
          {
            test: /\.css$/,
            use: [
              require.resolve('style-loader'),
              require.resolve('css-loader'),
            ],
          },
          {
            test: /\.(svg|ttf|eot|woff|woff2)$/,
            use: {
              loader: 'file-loader',
              options: {
                // Limit at 50k. larger files emitted into separate files
                limit: 5000,
                outputPath: 'fonts',
                name: '[name].[ext]',
              },
            },
          },
        ],
      },
      output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].js',
        chunkFilename: '[name].bundle.js',
      },
      resolve: {
        extensions: ['.ts', '.tsx', '.js', '.jsx'],
        modules: [
          path.resolve('../../node_modules'),
          path.resolve('./node_modules'),
          path.resolve('./src'),
        ],
        plugins: [
          new TsconfigPathsPlugin({
            configFile: path.resolve(__dirname, './tsconfig.json'),
          }),
        ],
        symlinks: false,
        cacheWithContext: false,
        fallback: {
          path: require.resolve('path-browserify'),
          os: require.resolve('os-browserify/browser'),
          fs: false,
          child_process: false,
          net: false,
          buffer: require.resolve('buffer/'),
          querystring: require.resolve('querystring-es3'),
        },
      },
    }),
  ];
};
